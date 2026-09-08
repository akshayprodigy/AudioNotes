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
  /** Where the sentence sits inside that turn's text, so the UI can highlight it. */
  charStart: number;
  charEnd: number;
}

export interface DraftItem {
  kind: Exclude<MinuteKind, 'summary' | 'narrative' | 'headline'>;
  text: string;
  sources: ItemSource[];
  anchorStartMs: number;
  anchorEndMs: number;
}

/**
 * The offset of `sentence` within `text`.
 *
 * splitSentences collapses whitespace, so a sentence it returns is not always a byte-for-byte
 * substring of the original turn. indexOf is tried first because it is right whenever the turn
 * had no runs of whitespace — the overwhelming majority — and a whitespace-insensitive scan is
 * the fallback. Returning [0, text.length] rather than [-1, -1] on failure keeps the anchor
 * pointing at the right turn: a slightly wide span is honest, a missing one is not.
 */
export function sentenceSpan(text: string, sentence: string): [number, number] {
  const direct = text.indexOf(sentence);
  if (direct >= 0) return [direct, direct + sentence.length];

  const squash = (s: string) => s.replace(/\s+/g, ' ');
  const map: number[] = [];
  let flat = '';
  let wasSpace = false;
  for (let i = 0; i < text.length; i++) {
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
  const at = flat.indexOf(squash(sentence));
  if (at < 0) return [0, text.length];
  const end = at + squash(sentence).length;
  return [map[at] ?? 0, (map[end - 1] ?? text.length - 1) + 1];
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
    for (const sentence of splitSentences(u.text)) {
      if (sentence.length < 4) continue;
      const [charStart, charEnd] = sentenceSpan(u.text, sentence);
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

  // Same caps and same order as extractMinutes, which the parity test asserts.
  return [
    ...decisions.slice(0, 20),
    ...actions.slice(0, 30),
    ...questions.slice(0, 20),
  ];
}
