// LLM minutes enhancement — chunked map-reduce over the transcript. This produces *better* minutes
// (summary prose, cleaner owners/actions) but is strictly best-effort: if generation or parsing
// fails, the caller keeps the deterministic rule-based minutes (the guaranteed floor).
//
// The heavy token generation happens natively (llama.cpp); this module only orchestrates:
// chunk the text, run map/reduce prompts, and parse the result. It takes an injected `generate`
// so it is unit-testable without the native module.
import type { Utterance, Speaker, MinuteKind } from './types';

export interface LlmMinute {
  kind: MinuteKind;
  content: string;
  source: 'llm';
}

export type GenerateFn = (prompt: string, maxTokens: number) => Promise<string>;

const CHUNK_CHARS = 6000; // ~a chunk small models can handle; ≈ several minutes of talk

export function transcriptLines(utterances: Utterance[], speakers: Speaker[]): string[] {
  const nameById = new Map(speakers.map(s => [s.id, s.displayName]));
  return utterances.map(u => {
    const who = u.speakerId ? nameById.get(u.speakerId) ?? 'Speaker' : 'Speaker';
    return `${who}: ${u.text}`;
  });
}

export function chunkTranscript(lines: string[], maxChars = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur.length + line.length + 1 > maxChars && cur.length > 0) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function mapPrompt(chunk: string): string {
  return (
    'Below is part of a meeting transcript. Extract only what is explicitly stated. ' +
    'List decisions, action items (with owner and any due date), and open questions. ' +
    'Be concise and factual; do not invent anything.\n\n' +
    `TRANSCRIPT:\n${chunk}\n\n` +
    'Format:\nDECISIONS:\n- ...\nACTIONS:\n- <task> — <owner> (due <when>)\nQUESTIONS:\n- ...'
  );
}

export function reducePrompt(notes: string): string {
  return (
    'These are notes from consecutive parts of ONE meeting. Merge them into final minutes. ' +
    'Remove duplicates. Only include what the notes support.\n\n' +
    `NOTES:\n${notes}\n\n` +
    'Respond with ONLY a JSON object, no prose, in exactly this shape:\n' +
    '{"summary":"2-3 sentence overview","decisions":["..."],' +
    '"actions":[{"text":"...","owner":"...","due":"..."}],"questions":["..."]}'
  );
}

// Extract the first balanced {...} block and parse it. Returns null if nothing parses.
export function parseMinutesJson(raw: string): LlmMinute[] | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: any;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const out: LlmMinute[] = [];
  const push = (kind: MinuteKind, content: string) => {
    const c = (content ?? '').toString().trim();
    if (c) out.push({ kind, content: c, source: 'llm' });
  };

  if (obj.summary) push('summary', obj.summary);
  for (const d of obj.decisions ?? []) push('decision', typeof d === 'string' ? d : d?.text);
  for (const a of obj.actions ?? []) {
    if (typeof a === 'string') {
      push('action', a);
    } else if (a) {
      let s = (a.text ?? '').toString();
      if (a.owner) s += ` — ${a.owner}`;
      if (a.due && String(a.due).trim() && !/^n\/?a$/i.test(String(a.due))) s += ` (due ${a.due})`;
      push('action', s);
    }
  }
  for (const q of obj.questions ?? []) push('question', typeof q === 'string' ? q : q?.text);

  return out.length > 0 ? out : null;
}

export async function enhanceMinutes(
  utterances: Utterance[],
  speakers: Speaker[],
  generate: GenerateFn,
): Promise<LlmMinute[] | null> {
  if (utterances.length === 0) return null;
  const lines = transcriptLines(utterances, speakers);
  const chunks = chunkTranscript(lines);

  let notes: string;
  if (chunks.length === 1) {
    notes = chunks[0];
  } else {
    // Map: summarize each chunk, then reduce the summaries.
    const mapped: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      mapped.push(await generate(mapPrompt(chunks[i]), 512));
    }
    notes = mapped.join('\n\n');
  }

  const reduced = await generate(reducePrompt(notes), 768);
  return parseMinutesJson(reduced);
}
