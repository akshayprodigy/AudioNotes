// Rule-based items, with the provenance the extractor already had and used to discard.
//
// src/pipeline/minutes.ts holds the rules; this file holds the bookkeeping. They are separate
// files because the rules are a parity contract with cpp/minutes/ and must not acquire new
// reasons to change, while provenance is bookkeeping that will keep changing.
import {
  DECISION,
  isAction,
  isQuestion,
  detectOwner,
  DUE,
  splitSentences,
  norm,
} from './minutes';
import type { Utterance, Speaker, MinuteKind } from './types';

/** One passage of the recording that supports an item. */
export interface ItemSource {
  /** Convenience only: re-minted on every ASR run, so never the identity. */
  utteranceId: string;
  /** The anchor. Same audio, same clock — survives re-ASR, edits and speaker merges. */
  startMs: number;
  endMs: number;
  /**
   * Where the sentence sits inside that turn's text, so the UI can highlight it.
   *
   * UTF-16 code units, matching JavaScript string indices — the C++ and Kotlin ports must
   * convert. Byte offsets and UTF-16 offsets diverge the moment the transcript has an em dash or
   * a curly apostrophe, and this one is full of both.
   */
  charStart: number;
  charEnd: number;
}

export interface DraftItem {
  kind: Exclude<MinuteKind, 'summary' | 'narrative' | 'headline'>;
  text: string;
  sources: ItemSource[];
  /**
   * The time range spanned by every source: earliest start to latest end. It is an envelope for
   * ordering the list and drawing a range on the transcript — NOT a play range. An item said at
   * 1000-3000ms and again at 8000-9500ms anchors at 1000-9500, seven seconds of which is someone
   * else's turn. Playback must seek to anchorStartMs, or to one specific sources[i], and must
   * never play the envelope start-to-end as if it were one continuous passage.
   */
  anchorStartMs: number;
  anchorEndMs: number;
}

/**
 * The offset of `sentence` within `text`, searching no earlier than the code-unit index `from`.
 *
 * splitSentences collapses whitespace, so a sentence it returns is not always a code-unit-for-
 * code-unit substring of the original turn — a line break or a doubled space inside it gets
 * squashed to one. `text.indexOf` is tried first because it is right whenever no whitespace run
 * falls *inside* the sentence — the common case — and a whitespace-insensitive scan is the
 * fallback for when one does.
 *
 * `from` is a cursor, not a hard boundary. A caller walking a turn sentence-by-sentence passes
 * the previous sentence's end so that a sentence repeated within one turn — whisper's
 * repetition-loop failure mode, on record from the Galaxy A07 field test — is matched at its own
 * occurrence each time rather than the first occurrence every time. But the cursor can overshoot
 * (the previous span came from the fallback path and landed slightly wide, say), so a search that
 * fails from `from` is retried from 0 before this gives up: a sentence the cursor has already
 * passed must still be found, not silently handed the whole-turn fallback below. Only when BOTH
 * searches fail does this return [0, text.length] — a slightly-too-wide anchor is honest, a
 * missing one is not, and text.length is always a valid end index into text itself.
 *
 * `sentence` is expected already trimmed, which is what splitSentences returns. This function
 * does not re-trim it, so a caller passing raw untrimmed text will get a span that runs into
 * the neighbouring whitespace.
 */
export function sentenceSpan(text: string, sentence: string, from = 0): [number, number] {
  return findFrom(text, sentence, from) ?? findFrom(text, sentence, 0) ?? [0, text.length];
}

/** One search attempt, starting no earlier than `from`. Null, not a sentinel span, on failure —
 *  sentenceSpan is what decides how to fall back, this just reports whether it found anything. */
function findFrom(text: string, sentence: string, from: number): [number, number] | null {
  const direct = text.indexOf(sentence, from);
  if (direct >= 0) return [direct, direct + sentence.length];

  // The needle, flattened the same way splitSentences flattens a whole turn, searched for in a
  // flattened copy of `text` from `from` onward. Flattening only the tail rather than maintaining
  // an incremental map across calls keeps this stateless and cheap: turns are a few sentences,
  // never large enough for the re-scan to matter.
  const needle = sentence.replace(/\s+/g, ' ');
  const map: number[] = [];
  let flat = '';
  let wasSpace = false;
  for (let i = from; i < text.length; i++) {
    const isSpace = /\s/.test(text[i]);
    if (isSpace) {
      if (!wasSpace && flat.length > 0) {
        map.push(i);
        flat += ' ';
      }
      wasSpace = true;
    } else {
      wasSpace = false;
      map.push(i);
      flat += text[i];
    }
  }
  const at = flat.indexOf(needle);
  if (at < 0) return null;
  // map has exactly one entry per character of `flat` — every branch above that appends to
  // `flat` also pushes to `map`, and only those branches do — and `indexOf` cannot return an
  // index outside flat's own bounds. So map[at] and map[at + needle.length - 1] are always
  // defined; no `?? 0` defensive fallback here, because one would silently paper over a bug in
  // the loop above rather than any input this function can actually receive.
  return [map[at], map[at + needle.length - 1] + 1];
}

export function extractItems(
  utterances: Utterance[],
  speakers: Speaker[] = [],
): DraftItem[] {
  const nameById = new Map<string, string>();
  for (const s of speakers) nameById.set(s.id, s.displayName);

  const actions: DraftItem[] = [];
  const decisions: DraftItem[] = [];
  const questions: DraftItem[] = [];
  const byKey = new Map<string, DraftItem>();

  const add = (
    arr: DraftItem[],
    kind: DraftItem['kind'],
    text: string,
    source: ItemSource,
  ) => {
    if (!text) return;
    const key = kind + '|' + norm(text);
    const existing = byKey.get(key);
    if (existing) {
      // Said twice. One item, two pieces of evidence — the report is explicit that an item may
      // cite several turns, and a repeat is the simplest case of it.
      existing.sources.push(source);
      existing.anchorStartMs = Math.min(existing.anchorStartMs, source.startMs);
      existing.anchorEndMs = Math.max(existing.anchorEndMs, source.endMs);
      return;
    }
    const item: DraftItem = {
      kind,
      text,
      sources: [source],
      anchorStartMs: source.startMs,
      anchorEndMs: source.endMs,
    };
    byKey.set(key, item);
    arr.push(item);
  };

  for (const u of utterances) {
    const speakerName = u.speakerId ? nameById.get(u.speakerId) ?? null : null;
    // Walked forward per turn, reset at each new one: this is what gives a sentence repeated
    // within a single turn two distinct spans instead of two sources both pointing at the first
    // occurrence. See sentenceSpan's own doc comment for what happens when this overshoots.
    let cursor = 0;
    for (const sentence of splitSentences(u.text)) {
      if (sentence.length < 4) continue;
      const [charStart, charEnd] = sentenceSpan(u.text, sentence, cursor);
      // Math.max, not a plain assignment: a span found via sentenceSpan's retry-from-0 fallback
      // can land BEFORE the cursor (that is the whole point of the fallback), and letting it pull
      // the cursor backward would make the next sentence's search re-cover ground this one
      // already claimed.
      cursor = Math.max(cursor, charEnd);
      const source: ItemSource = {
        utteranceId: u.id,
        startMs: u.startMs,
        endMs: u.endMs,
        charStart,
        charEnd,
      };

      if (isQuestion(sentence)) {
        add(questions, 'question', sentence, source);
        continue;
      }
      if (DECISION.test(sentence)) {
        add(decisions, 'decision', sentence, source);
        continue;
      }
      if (isAction(sentence)) {
        const owner = detectOwner(sentence, speakerName);
        const due = sentence.match(DUE);
        let text = sentence + ` — ${owner}`;
        if (due) text += ` (due ${due[0]})`;
        add(actions, 'action', text, source);
      }
    }
  }

  // Same caps and same order as extractMinutes — the 'matches extractMinutes even when every
  // bucket is over its cap' test in evidence.test.ts is what actually asserts this, by feeding
  // both functions 25 decisions, 35 actions and 25 questions (every cap below is smaller) and
  // comparing their output line for line.
  return [
    ...decisions.slice(0, 20),
    ...actions.slice(0, 30),
    ...questions.slice(0, 20),
  ];
}
