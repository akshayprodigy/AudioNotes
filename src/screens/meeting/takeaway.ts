/**
 * What a meeting opens with: ONE short takeaway, and the one-line previews that sit beside counts.
 *
 * Pure, so the rule is pinned without a screen. Nothing here invents: every word is the writer's
 * headline or a sentence the extractor lifted from the transcript, and a meeting with neither
 * leads with nothing rather than with a tally of its own output ("3 actions, 1 decision" says what
 * the app did, not what the meeting was).
 */
import { composeSummary } from '../../pipeline/minutes';
import type { Minute } from '../../pipeline/types';
import { sentenceCase, splitAction } from './shared';

/** The longest takeaway, in characters. A takeaway is read at a glance or it is not one. */
export const TAKEAWAY_CHARS = 220;
/** The longest one-line preview beside a count. */
export const PREVIEW_CHARS = 90;

/** Whitespace collapsed, clipped on a word boundary with an ellipsis. */
export function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/** The meeting's lead: the tally sentence composeSummary closes with is never part of it. */
const TALLY = /\s*\d+ action items?, \d+ decisions?, \d+ open questions?\.$/;

/**
 * The takeaway.
 *
 * Pro: the writer's headline, when it wrote one. Free (and Pro with no headline): the rule-based
 * lead the app already builds for the exported document, `composeSummary`, without its tally —
 * "Decided: …" when something was decided, otherwise "Next: …" from the first actions, owned ones
 * first and without their owner suffix. Null when the rules found neither.
 */
export function takeawayOf(input: {
  minutes: Minute[];
  /** Decision texts, in order, as the Minutes tab shows them. */
  decisions: string[];
  /** Action texts as stored (`<sentence> — <owner> (due …)`), in order. */
  actions: string[];
}): string | null {
  const headline = input.minutes.find(m => m.kind === 'headline' && m.content.trim());
  if (headline) return oneLine(headline.content, TAKEAWAY_CHARS);

  let lead = '';
  if (input.decisions.length > 0) {
    lead = composeSummary(input.decisions, [], []);
  } else if (input.actions.length > 0) {
    const owned = input.actions.filter(a => !a.includes(' — Unassigned'));
    const unowned = input.actions.filter(a => a.includes(' — Unassigned'));
    lead = composeSummary([], [...owned, ...unowned].map(a => splitAction(a).text), []);
  }
  lead = lead.replace(TALLY, '').trim();
  return lead ? oneLine(lead, TAKEAWAY_CHARS) : null;
}

/** The first item as one short sentence: owner and due suffix off, opening letter capitalised. */
export function previewOf(texts: string[]): string {
  if (texts.length === 0) return '';
  return oneLine(sentenceCase(splitAction(texts[0]).text), PREVIEW_CHARS);
}

/**
 * The line under a Library card's title: the writer's headline, else the first decision, else the
 * first next step. Never a count, and null when there is nothing to say.
 */
export function cardPreview(m: {
  summaryLine?: string | null;
  firstDecision?: string | null;
  firstAction?: string | null;
}): string | null {
  if (m.summaryLine && m.summaryLine.trim()) return oneLine(m.summaryLine, PREVIEW_CHARS);
  if (m.firstDecision && m.firstDecision.trim()) return `Decided: ${previewOf([m.firstDecision])}`;
  if (m.firstAction && m.firstAction.trim()) return `Next: ${previewOf([m.firstAction])}`;
  return null;
}
