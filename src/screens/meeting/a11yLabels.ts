/**
 * What a screen reader says for the meeting screen's rows and tabs, composed in one place so every
 * surface says the same thing and a test can pin it.
 *
 * Nothing here is colour: an owner, a due date and whether it is done are WORDS in the label, as
 * they are words on the screen.
 */
import { NO_OWNER_YET, sentenceCase, splitAction } from './shared';

const tidy = (s: string) => s.replace(/[\s.;,]+$/, '').trim();

/**
 * One next step: "<text>. Owner <name>. Due <date>. Not done". An action nobody owns says "No owner
 * yet"; one with no due date says nothing about a date; `done` undefined (a surface that does not
 * know) says nothing about progress.
 */
export function actionA11yLabel(content: string, done?: boolean): string {
  const { text, owner, due } = splitAction(content);
  const parts = [`${tidy(sentenceCase(text))}.`];
  parts.push(owner ? `Owner ${owner}.` : `${NO_OWNER_YET}.`);
  if (due) parts.push(`Due ${due.replace(/^due\s+/i, '')}.`);
  if (done !== undefined) parts.push(done ? 'Done' : 'Not done');
  return parts.join(' ');
}

/** A decision or an open question: just what it says. */
export function plainA11yLabel(content: string): string {
  return tidy(sentenceCase(splitAction(content).text));
}

/** "Minutes, tab 2 of 4". The screen reader adds "selected" from the tab's state. */
export function tabA11yLabel(label: string, index: number, total: number): string {
  return `${label}, tab ${index + 1} of ${total}`;
}
