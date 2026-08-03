// Rule-based minutes — the deterministic Free-tier floor. No model, no network.
// Extracts action items (with best-effort owner + due date), decisions, and open questions
// from the transcript, plus a factual overview line. The on-device LLM (milestone 5) will
// *enhance* this; it must never be a dependency — these minutes stand on their own.
//
// Patterns are English-first but structured so more languages can be added as extra cue lists.
import type { Utterance, Speaker, MinuteKind } from './types';

export interface DraftMinute {
  kind: MinuteKind;
  content: string;
  source: 'rule';
}

const ACTION_FIRST_PERSON = /\b(i['’]ll|i will|i am going to|i'm going to|let me|we['’]ll|we will|we need to|let['’]s)\b/i;
const ACTION_ASSIGN = /\b(can you|could you|would you|please|you need to|you should|make sure (you|to)|assign(ed)? to)\b/i;
const ACTION_OBLIGATION = /\b(need to|needs to|have to|has to|must|should|going to|will send|will get|will do|follow[- ]?up|action item|to-?do)\b/i;
const IMPERATIVE_VERBS = [
  'send', 'prepare', 'schedule', 'email', 'call', 'review', 'update', 'create', 'finish',
  'draft', 'share', 'set up', 'book', 'confirm', 'check', 'fix', 'add', 'remove', 'ping',
];

const DECISION = /\b(we decided|the decision|we agreed|agreed to|let['’]s go with|we['’]ll go with|we chose|going with|we['’]re going with|finali[sz]ed|sign(ed)? off|approved|conclusion is)\b/i;

const DUE = /\b(today|tonight|tomorrow|this (morning|afternoon|evening|week|month)|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|by (the )?(end of (the )?(day|week|month)|eod|cob|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|\w+day)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in \d+ (day|days|week|weeks)|\d{1,2}(st|nd|rd|th)?( of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i;

const NAMED_OWNER = /\b([A-Z][a-z]{1,20})\s+(?:will|to|should|is going to|needs to|has to|can|could|please)\b/;

const QUESTION_WORDS = /^(what|why|how|when|where|who|which|should we|do we|can we|are we|is it|could we|would it)\b/i;

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function startsWithImperative(sentence: string): boolean {
  const first = sentence.trim().toLowerCase();
  return IMPERATIVE_VERBS.some(v => first.startsWith(v + ' '));
}

function detectOwner(sentence: string, speakerName: string | null): string {
  const named = sentence.match(NAMED_OWNER);
  if (named) {
    const n = named[1];
    // Skip sentence-initial capitalized words that are just the first word.
    if (!/^(I|We|You|The|This|That|It|Let|Please)$/.test(n)) return n;
  }
  if (ACTION_FIRST_PERSON.test(sentence) && speakerName) return speakerName;
  if (ACTION_ASSIGN.test(sentence)) return 'Unassigned';
  return 'Unassigned';
}

function isAction(sentence: string): boolean {
  return (
    ACTION_FIRST_PERSON.test(sentence) ||
    ACTION_ASSIGN.test(sentence) ||
    ACTION_OBLIGATION.test(sentence) ||
    startsWithImperative(sentence)
  );
}

function isQuestion(sentence: string): boolean {
  const t = sentence.trim();
  return t.endsWith('?') || (QUESTION_WORDS.test(t) && t.length < 160);
}

export function extractMinutes(
  utterances: Utterance[],
  speakers: Speaker[] = [],
): DraftMinute[] {
  const nameById = new Map<string, string>();
  for (const s of speakers) nameById.set(s.id, s.displayName);

  const actions: DraftMinute[] = [];
  const decisions: DraftMinute[] = [];
  const questions: DraftMinute[] = [];
  const seen = new Set<string>();

  const add = (arr: DraftMinute[], kind: MinuteKind, content: string) => {
    const key = kind + '|' + norm(content);
    if (!content || seen.has(key)) return;
    seen.add(key);
    arr.push({ kind, content, source: 'rule' });
  };

  for (const u of utterances) {
    const speakerName = u.speakerId ? nameById.get(u.speakerId) ?? null : null;
    for (const sentence of splitSentences(u.text)) {
      if (sentence.length < 4) continue;

      if (isQuestion(sentence)) {
        add(questions, 'question', sentence);
        continue; // a question is not also an action
      }
      if (DECISION.test(sentence)) {
        add(decisions, 'decision', sentence);
        continue;
      }
      if (isAction(sentence)) {
        const owner = detectOwner(sentence, speakerName);
        const due = sentence.match(DUE);
        let content = sentence;
        content += ` — ${owner}`;
        if (due) content += ` (due ${due[0]})`;
        add(actions, 'action', content);
      }
    }
  }

  const trimmed = {
    actions: actions.slice(0, 30),
    decisions: decisions.slice(0, 20),
    questions: questions.slice(0, 20),
  };

  const summary: DraftMinute = {
    kind: 'summary',
    content:
      `${trimmed.actions.length} action item${trimmed.actions.length === 1 ? '' : 's'}, ` +
      `${trimmed.decisions.length} decision${trimmed.decisions.length === 1 ? '' : 's'}, ` +
      `${trimmed.questions.length} open question${trimmed.questions.length === 1 ? '' : 's'}.`,
    source: 'rule',
  };

  // Order: overview, then decisions, actions, questions.
  return [summary, ...trimmed.decisions, ...trimmed.actions, ...trimmed.questions];
}
