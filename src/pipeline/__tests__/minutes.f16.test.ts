// F16 (A07 defect 12a-c): three extractor rules, pinned sentence by sentence.
//
//   (a) "let's start|begin|get started|kick off" with no time marker is a meeting-flow phrase.
//   (b) "<Name> will <verb>" is an action for ANY verb once it has a due or an object.
//   (c) "before <day>" is a due.
//
// The sentences marked A07 are the Galaxy A07's own words, verbatim. Every row here is also in the
// F16 fixture of minutes.golden.test.ts, which is what the C++ port replays; this file is the
// readable half - one named test per rule, so a broken rule names itself.
import { isAction, detectOwner, extractMinutes, DUE } from '../minutes';
import { resolveDay } from '../dateNorm';

const action = (s: string) => isAction(s);
const due = (s: string) => s.match(DUE)?.[0] ?? null;

describe('F16 (a): meeting-flow "let\'s start" is not an action', () => {
  it('A07: "Let\'s start the weekly check-in." is not an action', () => {
    expect(action("Let's start the weekly check-in.")).toBe(false);
  });
  it.each([
    "Let's begin the review.",
    "Let's get started.",
    "Alright team, let's kick off the design review.",
    'Let’s start the weekly check-in.',
    "Let's start.",
    "Let's start",
  ])('"%s" is flow, not an action', s => {
    expect(action(s)).toBe(false);
  });
  // Nothing A069, 8 Oct: the chair closing the meeting was listed as a to-do ("Let's wrap up there.",
  // Owner Speaker 1). Same class as "Let's start the weekly check-in", so the same rule.
  it.each([
    "Let's wrap up there.",
    "Let's wrap up",
    "Okay, let's wrap this up now.",
    "Alright, let's wrap things up.",
    "Let's wrap up the meeting.",
    "Let's move on.",
    "Okay let's get going.",
    "Let's call it a day.",
  ])('"%s" closes or moves the meeting, not an action', s => {
    expect(action(s)).toBe(false);
  });
  it.each([
    "Let's wrap up the migration.",
    "Let's wrap up the report by Friday.",
    "Let's wrap up there, and I'll send the notes.",
    "Let's wrap up the migration on Monday.",
  ])('"%s" wraps up a piece of work (or has a time or a second cue), so it stays an action', s => {
    expect(action(s)).toBe(true);
  });
  it.each([
    "Let's start the migration on Monday.",
    "Let's start the migration tomorrow.",
    "Let's kick off the review next week.",
    "Let's begin the rollout by Friday.",
    "Let's get started after lunch.",
    "Let's start the audit in 3 days.",
  ])('"%s" carries a time marker so it stays an action', s => {
    expect(action(s)).toBe(true);
  });
  it('another cue in the same sentence keeps it an action', () => {
    expect(action("Let's start, and I'll send the notes.")).toBe(true);
    expect(action("Let's start the call, please share your screen.")).toBe(true);
  });
  it('other let\'s phrases are untouched', () => {
    expect(action("Let's move the demo to Monday.")).toBe(true);
    expect(action("Let's review the budget.")).toBe(true);
  });
  it('a surviving let\'s-start action still goes to the speaker', () => {
    expect(detectOwner("Let's start the migration on Monday.", 'Speaker 1')).toBe('Speaker 1');
  });
});

describe('F16 (b): "<Name> will <verb>" for any verb', () => {
  it('A07: "Rahul will recruit ten more testers by Monday." is an action with owner and due', () => {
    const s = 'Rahul will recruit ten more testers by Monday.';
    expect(action(s)).toBe(true);
    expect(detectOwner(s, 'Speaker 1')).toBe('Rahul');
    expect(due(s)).toBe('by Monday');
  });
  it('an object (two words after the verb) is enough without a due', () => {
    expect(action('Rahul will recruit ten testers.')).toBe(true);
    expect(action('Meera will sketch the new onboarding flow.')).toBe(true);
  });
  it('a due is enough without an object', () => {
    expect(action('Rahul will recruit tomorrow.')).toBe(true);
    expect(action('Rahul will triage Friday.')).toBe(false); // bare day, no marker: one word, no due
  });
  it('a verb with neither a due nor two words after it is not enough', () => {
    expect(action('Rahul will recruit.')).toBe(false);
    expect(action('Rahul will recruit testers.')).toBe(false);
  });
  it('hedges are skipped and the clause is judged the same way', () => {
    expect(action('Rahul will probably recruit ten more testers.')).toBe(true);
    expect(action('Rahul will probably also recruit testers by Monday.')).toBe(true);
    expect(action('Rahul will probably recruit.')).toBe(false);
  });
  it.each([
    'Priya will be late.',
    'Priya will be late on Friday.',
    'Priya will be the lead on this.',
    'Priya will been there for ten years.',
    'Priya will being the lead on this.',
    'We will not ship Friday.',
    'Priya will not ship the build by Friday.',
    'Priya will probably not ship the build tomorrow.',
    'Priya will never agree to that deal.',
    'I think Priya will.',
    'It will probably rain during the offsite.',
    'The new office will be bigger than this one.',
    'She will recruit ten more testers.',
    'They will recruit ten more testers.',
  ])('"%s" is not an action', s => {
    expect(action(s)).toBe(false);
  });
  it('the closed list still works as a fast path', () => {
    expect(action('Kraya will prepare the play store listing by Friday.')).toBe(true);
    expect(action('Maya will send it.')).toBe(true);
  });
  it('a first-person future with a negation is not a commitment', () => {
    expect(action('We will not ship Friday.')).toBe(false);
    expect(action('I will not send it tomorrow.')).toBe(false);
    expect(action('We will ship Friday.')).toBe(true);
  });
});

describe('F16 (c): "before <day>" is a due', () => {
  it('A07: "before Wednesday" is found', () => {
    expect(due('Please finish the audit before Wednesday.')).toBe('before Wednesday');
  });
  it.each([
    ['Send the deck before Monday.', 'before Monday'],
    ['Send the deck before today.', 'before today'],
    ['Send the deck before tomorrow.', 'before tomorrow'],
    ['Send the deck before next Friday.', 'before next Friday'],
    ['Send the deck before next week.', 'before next week'],
    ['Send the deck before the end of the week.', 'before the end of the week'],
    ['Send the deck before 21st of Oct.', 'before 21st of Oct'],
    ['Send the deck before noon.', 'before noon'],
  ])('"%s" -> %s', (s, want) => {
    expect(due(s)).toBe(want);
  });
  it('"before" with no date after it is not a due', () => {
    expect(due('Send the deck before the launch.')).toBeNull();
    expect(due('We talked about this before.')).toBeNull();
  });
  it('shows in the action as "(due before Wednesday)"', () => {
    const out = extractMinutes(
      [{ text: 'Priya should send the audit before Wednesday.', speakerId: 'S0' }] as any,
      [{ id: 'S0', displayName: 'Speaker 1' }] as any,
    );
    expect(out.find(m => m.kind === 'action')!.content).toBe(
      'Priya should send the audit before Wednesday. — Priya (due before Wednesday)',
    );
  });
  it('a deadline is not a day: "before ..." stays unresolved for the review queue', () => {
    const at = Date.UTC(2026, 8, 16, 9, 30); // Wed 16 Sep 2026
    expect(resolveDay('before Wednesday', at, 'Asia/Kolkata')).toBeNull();
    expect(resolveDay('before tomorrow', at, 'Asia/Kolkata')).toBeNull();
    expect(resolveDay('before next Friday', at, 'Asia/Kolkata')).toBeNull();
    // ...while the same words after "by" do resolve, so the null is the rule and not the date.
    expect(resolveDay('by Wednesday', at, 'Asia/Kolkata')).toBe('2026-09-23');
    expect(resolveDay('by tomorrow', at, 'Asia/Kolkata')).toBe('2026-09-17');
  });
});
