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
// `will <verb>` rather than bare `will`: "Kraya will prepare the listing by Friday" is the most
// ordinary action sentence a meeting produces and was not one until 14 September, because the
// old list stopped at send/get/do. "It will rain" must stay out, so the verb is required.
// Mirrored in cpp/minutes/minutes_extractor.cpp; the goldens keep the two in step.
const ACTION_OBLIGATION = /\b(need to|needs to|have to|has to|must|should|going to|will (send|get|do|prepare|schedule|email|call|review|update|create|finish|draft|share|set up|book|confirm|check|fix|add|remove|ping|write|handle|arrange|circulate|deliver|submit|publish|post|present|report|test|deploy|release|ship|record|contact|notify|remind|invite|organi[sz]e|look into|follow up|reach out|take care|sort out|own|lead|start|complete)|follow[- ]?up|action item|to-?do)\b/i;
const IMPERATIVE_VERBS = [
  'send', 'prepare', 'schedule', 'email', 'call', 'review', 'update', 'create', 'finish',
  'draft', 'share', 'set up', 'book', 'confirm', 'check', 'fix', 'add', 'remove', 'ping',
];

// "we have decided that the launch goes ahead" produced no decision on the A07: only the simple
// past was listed. The perfect, the passive and the plain "decided to/that" are how people
// actually report one. Mirrored in cpp/minutes/minutes_extractor.cpp.
export const DECISION = /\b(we decided|we have decided|we['’]ve decided|it was decided|it['’]s been decided|decided (that|to)|the decision|decision (is|was)|we agreed|agreed (to|that)|let['’]s go with|we['’]ll go with|we chose|going with|we['’]re going with|finali[sz]ed|sign(ed)? off|approved|conclusion is)\b/i;

// A schedule change reported as already made is a decision. "Shipping moved to Thursday because
// QA is not done" produced no item at all on the A07 (22 Sep), so a thread's "changes:" link
// never fired on the commonest kind of changed decision.
//
// Three parts. The verb and an explicit new time must both be in the sentence; a phrasing that
// makes the verb an INTENTION disqualifies it, because "we need to move the review to Friday" is
// an action somebody still owes and must stay one.
//
// The verb list holds every form, including the bare infinitive, and that is not laziness: on the
// A07 (22 Sep, twice) whisper-base transcribed the spoken "shipping moved to Thursday" as
// "Shipping move to Thursday" — the "-d" is swallowed before the /t/ of "to". A rule that leaned
// on the past tense fired on the written sentence and never on the spoken one, which is the only
// one a meeting produces. SCHEDULE_INTENT carries the distinction instead, and it is a positive
// pattern rather than a lookbehind because std::regex has none (see the port's header).
// The time half is why "I moved to Bangalore last year" and "he pushed back on the price" are not
// decisions. Mirrored in cpp/minutes/minutes_extractor.cpp; the goldens keep the two in step.
export const SCHEDULE_VERB = /\b(move|moves|moved|push|pushes|pushed|postpone|postpones|postponed|delay|delays|delayed|reschedule|reschedules|rescheduled|shift|shifts|shifted|slip|slips|slipped|bump|bumps|bumped|bring forward|brings forward|brought forward|pull forward|pulls forward|pulled forward|put back|puts back)\b/i;
export const SCHEDULE_WHEN = /\b(to|till|until|into|for)\s+(the\s+)?(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (week|month|morning|afternoon|evening)|the (end of (the )?(day|week|month)|weekend)|q[1-4]|\d{1,2}(st|nd|rd|th)?( of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})\b/i;

// The verb as an intention rather than a report: after "to" (which covers need to / have to /
// going to / want to / plan to in one), or after a modal, with an optional pronoun between.
export const SCHEDULE_INTENT = /\b(to|must|should|shall|will|would|can|could|may|might|let['’]s|please)\s+(you |we |i |they |he |she |it )?(move|push|postpone|delay|reschedule|shift|bump|bring forward|pull forward|put back)\b/i;

/** The decision test both extractors use. A wrapper so there is one place the rule can drift. */
export function isDecision(sentence: string): boolean {
  if (DECISION.test(sentence)) return true;
  return (
    SCHEDULE_VERB.test(sentence) && SCHEDULE_WHEN.test(sentence) && !SCHEDULE_INTENT.test(sentence)
  );
}

export const DUE = /\b(today|tonight|tomorrow|this (morning|afternoon|evening|week|month)|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|by (the )?(end of (the )?(day|week|month)|eod|cob|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|\w+day)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in \d+ (day|days|week|weeks)|\d{1,2}(st|nd|rd|th)?( of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i;

const NAMED_OWNER = /\b([A-Z][a-z]{1,20})\s+(?:will|to|should|is going to|needs to|has to|can|could|please)\b/;

const QUESTION_WORDS = /^(what|why|how|when|where|who|which|should we|do we|can we|are we|is it|could we|would it)\b/i;

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function startsWithImperative(sentence: string): boolean {
  const first = sentence.trim().toLowerCase();
  return IMPERATIVE_VERBS.some(v => first.startsWith(v + ' '));
}

export function detectOwner(sentence: string, speakerName: string | null): string {
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

export function isAction(sentence: string): boolean {
  return (
    ACTION_FIRST_PERSON.test(sentence) ||
    ACTION_ASSIGN.test(sentence) ||
    ACTION_OBLIGATION.test(sentence) ||
    startsWithImperative(sentence)
  );
}

// ASCII-alnum runs rather than \p{L}: the C++ port matches bytes with std::regex and has no
// Unicode classes, so a Unicode-aware count here would diverge from it on exactly the text no
// golden covers. English-only for v1.
const WORDS = /[A-Za-z0-9]+/g;

export function isQuestion(sentence: string): boolean {
  const t = sentence.trim();
  if (!(t.endsWith('?') || (QUESTION_WORDS.test(t) && t.length < 160))) return false;
  // "Okay?", "What?", "And what?" are how a transcript renders a pause, and they were listed as
  // open questions on real speech. Three words is the floor. A sentence with no ASCII words at
  // all is left to the caller's length filter — see the emoji row in the goldens.
  const words = t.match(WORDS)?.length ?? 0;
  return words === 0 || words >= 3;
}


// ---- The free-tier summary ----------------------------------------------------------------
//
// How many items the overview quotes before it stops being an overview. Two decisions and three
// actions fit in a paragraph somebody reads; past that the tally sentence carries the rest.
const LEAD_DECISIONS = 2;
const LEAD_ACTIONS = 3;
// Rule items are whole sentences lifted from the transcript, and people speak in long ones.
const LEAD_ITEM_CHARS = 160;

// An action with nobody's name on it. detectOwner writes this exact word when it cannot find one,
// so the check is a substring rather than anything cleverer.
const UNASSIGNED = ' — Unassigned';

/** One quoted item, tidied for use inside a sentence: collapsed, clipped on a word boundary, and
 *  stripped of the trailing punctuation that would collide with the "; " it is joined with. */
function leadItem(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  if (t.length > LEAD_ITEM_CHARS) t = t.slice(0, LEAD_ITEM_CHARS).replace(/\s+\S*$/, '') + '…';
  return t.replace(/[.;,]+$/, '');
}

/**
 * The overview line at the top of the rule-based minutes.
 *
 * This is the free tier's summary — the first thing in an exported Markdown file, and therefore
 * the document a free user forwards to a colleague. It used to be the tally alone: "12 action
 * items, 3 decisions, 5 open questions." Every word of that is true and none of it says what the
 * meeting was, which made the export read like a receipt for work the app had done rather than a
 * record of what was agreed.
 *
 * So it leads with what was decided and who owes what, and keeps the tally as the closing sentence
 * so nothing that used to be there is lost. Actions with a named owner are quoted ahead of
 * unowned ones because "Priya will send the report by Friday" is worth more to the reader than
 * an obligation nobody has taken. A meeting with neither decisions nor actions composes to
 * exactly the old tally sentence, which is the honest thing to say about it.
 *
 * Deliberately a port of FileExportModule.kt's fallback composition (Kotlin) and of
 * cpp/minutes/minutes_extractor.cpp (the shared core that actually writes these rows on device).
 * The three must stay word-for-word identical: a free user who exports a meeting from the app and
 * one whose minutes were written by the native pipeline must get the same paragraph, and the
 * golden fixtures in cpp/tests/golden are what holds them together.
 */
export function composeSummary(
  decisions: string[],
  actions: string[],
  questions: string[],
): string {
  const tally =
    `${actions.length} action item${actions.length === 1 ? '' : 's'}, ` +
    `${decisions.length} decision${decisions.length === 1 ? '' : 's'}, ` +
    `${questions.length} open question${questions.length === 1 ? '' : 's'}.`;

  const sentences: string[] = [];
  if (decisions.length > 0) {
    sentences.push('Decided: ' + decisions.slice(0, LEAD_DECISIONS).map(leadItem).join('; ') + '.');
  }
  if (actions.length > 0) {
    const owned = actions.filter(a => !a.includes(UNASSIGNED));
    const unowned = actions.filter(a => a.includes(UNASSIGNED));
    const lead = [...owned, ...unowned].slice(0, LEAD_ACTIONS);
    sentences.push('Next: ' + lead.map(leadItem).join('; ') + '.');
  }
  sentences.push(tally);
  return sentences.join(' ');
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
      if (isDecision(sentence)) {
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
    content: composeSummary(
      trimmed.decisions.map(m => m.content),
      trimmed.actions.map(m => m.content),
      trimmed.questions.map(m => m.content),
    ),
    source: 'rule',
  };

  // Order: overview, then decisions, actions, questions.
  return [summary, ...trimmed.decisions, ...trimmed.actions, ...trimmed.questions];
}
