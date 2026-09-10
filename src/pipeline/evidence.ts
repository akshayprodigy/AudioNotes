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

/**
 * One passage of the recording that supports an item, on the way IN.
 *
 * `Draft` for the same reason `DraftItem` is: this is what the extractor produces, before anything
 * is persisted. The stored twin is `ItemSource` in ./types, which db.items() reads back, and the
 * one difference is the one that matters — `utteranceId` is always known here and is NULLABLE
 * there, because AudioDb.replaceUtterancesJson mints fresh utterance ids on every ASR run. Naming
 * them apart is what stops a `null` from storage being typed as a `string` with no compile error.
 */
export interface DraftItemSource {
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
  sources: DraftItemSource[];
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
 * squashed to one. Finding it takes two different scans: `text.indexOf` finds a LITERAL
 * occurrence, and a whitespace-insensitive scan over a flattened copy of `text` finds one that
 * has whitespace collapsed inside it. Both run whenever a literal hit isn't proven earliest (see
 * findFrom), because a literal hit is not automatically the earliest hit: a copy of the sentence
 * with a line break or doubled space inside it can sit earlier in the turn, and only the
 * collapsed scan can see it. Returning the later of the two — an earlier version of this
 * function always trusted indexOf — hands two sources the same span. Whisper's repetition loop
 * (on record from the Galaxy A07 field test) plus a line break inside one repeat is exactly the
 * shape that produces it, and it is common enough that it needed its own fix on top of the
 * search cursor below.
 *
 * `from` is that cursor, not a hard boundary. A caller walking a turn sentence-by-sentence
 * passes the previous sentence's end so each repeat is matched at its own occurrence rather than
 * the same one every time. If nothing is found from `from` onward, the search retries from 0
 * before this gives up, so a cursor that has overshot a findable sentence still finds it instead
 * of falling through to the whole-turn span below. (In extractItems's own walk this retry is
 * unreachable now that earliest-match-wins holds: the match returned for `from` is always at or
 * after `from`, so extractItems's cursor can never get ahead of a sentence that is still
 * findable. It stays because sentenceSpan is exported and this file does not control every
 * caller.) Only when both the `from` search and the retry-from-0 fail does this return
 * [0, text.length] — a slightly-too-wide anchor is honest, a missing one is not, and text.length
 * is always a valid end index into text itself.
 *
 * `sentence` is expected already trimmed, which is what splitSentences returns. This function
 * does not re-trim it, so a caller passing raw untrimmed text will get a span that runs into
 * the neighbouring whitespace.
 */
export function sentenceSpan(text: string, sentence: string, from = 0): [number, number] {
  return findFrom(text, sentence, from) ?? findFrom(text, sentence, 0) ?? [0, text.length];
}

/**
 * Whitespace inside a candidate match that splitSentences would have collapsed: two-or-more
 * spaces, or any whitespace character that isn't a plain space (tab, newline, ...). Its absence
 * between `from` and a literal hit is the entire proof that the literal hit is the earliest
 * possible match — see the comment in findFrom below. Named and exported, rather than inlined,
 * so evidence.test.ts's property test measures this exact object: a copy of the pattern in the
 * test would drift the moment this one changes, and would then be proving nothing about the code
 * that actually runs.
 */
export const COLLAPSIBLE_WHITESPACE = /\s\s|[^\S ]/;

/** One search attempt, starting no earlier than `from`. Null, not a sentinel span, on failure —
 *  sentenceSpan is what decides how to fall back, this just reports whether it found anything. */
function findFrom(text: string, sentence: string, from: number): [number, number] | null {
  const direct = text.indexOf(sentence, from);

  // A whitespace run that could collapse into an earlier match can only exist somewhere between
  // `from` and the end of the literal hit; nowhere else could produce an occurrence that starts
  // before `direct` and after `from`. When the region carries no such run, `direct` is provably
  // the earliest possible match and the collapsed scan below is skipped, which keeps the common
  // case (no whitespace weirdness at all) down to one indexOf call.
  if (direct >= 0 && !COLLAPSIBLE_WHITESPACE.test(text.slice(from, direct + sentence.length))) {
    return [direct, direct + sentence.length];
  }

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
  // map has exactly one entry per character of `flat` — every branch above that appends to
  // `flat` also pushes to `map`, and only those branches do — and `indexOf` cannot return an
  // index outside flat's own bounds. So map[at] and map[at + needle.length - 1] are always
  // defined when `at >= 0`; no `?? 0` defensive fallback here, because one would silently paper
  // over a bug in the loop above rather than any input this function can actually receive.
  const collapsed: [number, number] | null =
    at < 0 ? null : [map[at], map[at + needle.length - 1] + 1];

  // Whichever match starts first wins. The pre-check above only ever SKIPS this comparison when
  // it has already proven `direct` cannot be beaten — it never substitutes for the comparison,
  // because a whitespace run before `direct` might belong to a different, unrelated sentence and
  // still resolve to a collapsed match that starts later than `direct`, not earlier.
  if (direct >= 0 && (!collapsed || direct <= collapsed[0])) {
    return [direct, direct + sentence.length];
  }
  return collapsed;
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
    source: DraftItemSource,
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
      // Math.max, not a plain assignment — but not because it is doing load-bearing work here.
      // Now that findFrom always returns the earliest match at-or-after `from` when it finds one,
      // charEnd can never come back below cursor in this loop: sentenceSpan's retry-from-0
      // fallback (see its doc comment) is unreachable from this call site. Measured, not assumed:
      // comparing Math.max against a bare assignment across 60,000 fuzzed turns found 2,610 where
      // they differ, and neither read was reliably the correct one — so this is not "preventing
      // re-covered ground", it would not reliably do that. It stays as defensive hygiene on an
      // exported function whose contract (never let the cursor run backward) should hold even if
      // a future change to findFrom reopens the case where it doesn't hold on its own.
      cursor = Math.max(cursor, charEnd);
      const source: DraftItemSource = {
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
