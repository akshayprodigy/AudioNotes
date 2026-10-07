import { namesOf, ownerAfterEdit, ownerLabel, ownerSpeakerId, resolveOwnerText, stripUnassigned } from '../itemOwner';

// The same vectors as ItemOwnerTest.kt: the Kotlin and TypeScript resolvers must not drift.
const spk = JSON.stringify({ kind: 'speaker', id: 's1' });
const priya = new Map([['s1', 'Priya']]);

test('a renamed speaker shows its current name and never the old one', () => {
  const out = resolveOwnerText('Send the report — Speaker 1', spk, priya);
  expect(out).toBe('Send the report — Priya');
  expect(out).not.toContain('Speaker 1');
});

test('the due tail survives', () => {
  expect(resolveOwnerText('Update the roadmap — Speaker 1 (due by Thursday)', spk, priya)).toBe(
    'Update the roadmap — Priya (due by Thursday)',
  );
});

test('an Unassigned token is replaced when the record says speaker', () => {
  expect(resolveOwnerText('Ship it — Unassigned', spk, priya)).toBe('Ship it — Priya');
});

test('a named person in the text is left alone', () => {
  const person = JSON.stringify({ kind: 'person', name: 'Maya' });
  expect(resolveOwnerText('Send the summary — Maya', person, priya)).toBe('Send the summary — Maya');
  expect(resolveOwnerText('Send the summary — Maya', null, priya)).toBe('Send the summary — Maya');
});

test('only kind speaker resolves, whatever else the record carries', () => {
  const person = JSON.stringify({ kind: 'person', id: 's1', name: 'Maya' });
  expect(resolveOwnerText('Send it — Maya', person, priya)).toBe('Send it — Maya');
  expect(ownerSpeakerId(person)).toBeNull();
});

test('a hand-typed owner is left alone', () => {
  const unassigned = JSON.stringify({ kind: 'unassigned' });
  expect(resolveOwnerText('Call Dana — Dana', unassigned, priya)).toBe('Call Dana — Dana');
});

test('a speaker with no name keeps the stored text', () => {
  expect(resolveOwnerText('Do it — Speaker 1', spk, new Map())).toBe('Do it — Speaker 1');
  expect(resolveOwnerText('Do it — Speaker 1', spk, new Map([['s1', null]]))).toBe('Do it — Speaker 1');
  expect(resolveOwnerText('Do it — Speaker 1', spk, new Map([['s1', '  ']]))).toBe('Do it — Speaker 1');
  expect(resolveOwnerText('Do it — Speaker 1', 'not json', priya)).toBe('Do it — Speaker 1');
});

test('ownerSpeakerId reads only a speaker owner', () => {
  expect(ownerSpeakerId(spk)).toBe('s1');
  expect(ownerSpeakerId(JSON.stringify({ kind: 'person', name: 'x' }))).toBeNull();
  expect(ownerSpeakerId(null)).toBeNull();
});

test('namesOf maps speakers by id', () => {
  expect(namesOf([{ id: 's1', displayName: 'Priya' } as any]).get('s1')).toBe('Priya');
});

test('ownerLabel is what the review queue always showed', () => {
  const sp = [{ id: 's1', displayName: 'Priya' }];
  expect(ownerLabel(spk, sp)).toBe('Priya');
  expect(ownerLabel(null, sp)).toBe('No owner');
  expect(ownerLabel(JSON.stringify({ kind: 'person', name: 'Maya' }), sp)).toBe('Maya');
  expect(ownerLabel(JSON.stringify({ kind: 'speaker', id: 'gone' }), sp)).toBe('A speaker');
});

test('a hand edit that keeps the speaker keeps the link; one that changes the owner drops it', () => {
  expect(ownerAfterEdit(spk, 'Priya', 'Send it — Priya (due Friday)')).toBeNull();
  expect(ownerAfterEdit(spk, 'Priya', 'Send it — priya')).toBeNull();
  expect(ownerAfterEdit(spk, 'Priya', 'Send it — Dana')).toBe(JSON.stringify({ kind: 'person', name: 'Dana' }));
  expect(ownerAfterEdit(spk, 'Priya', 'Send it')).toBe(JSON.stringify({ kind: 'unassigned' }));
  expect(ownerAfterEdit(spk, 'Priya', 'Send it — Unassigned')).toBe(JSON.stringify({ kind: 'unassigned' }));
  // No speaker link, nothing to reconcile.
  expect(ownerAfterEdit(null, null, 'Send it — Dana')).toBeNull();
});

test('search drops the extractor "— Unassigned" tail and nothing else', () => {
  expect(stripUnassigned('Send the report — Unassigned')).toBe('Send the report');
  expect(stripUnassigned('Send the report — \u0002Unassigned\u0003')).toBe('Send the report');
  expect(stripUnassigned('Ship it — Priya (due Friday)')).toBe('Ship it — Priya (due Friday)');
});
