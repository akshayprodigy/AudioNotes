import { itemKey } from '../src/screens/meeting/ActionsTab';

/**
 * The checkbox key is the whole reason ticks survive a reprocess. Minutes rows are deleted and
 * re-inserted whenever a meeting is reprocessed or its speakers are merged, so the key must depend
 * on the text and nothing else.
 */
describe('itemKey', () => {
  it('is stable for the same text', () => {
    expect(itemKey('Ana to draft the mapping table')).toBe(
      itemKey('Ana to draft the mapping table'),
    );
  });

  it('ignores whitespace and case, which change when minutes are re-extracted', () => {
    const base = itemKey('Ana to draft the mapping table');
    expect(itemKey('  Ana to draft the mapping table  ')).toBe(base);
    expect(itemKey('Ana  to   draft the mapping table')).toBe(base);
    expect(itemKey('ANA TO DRAFT THE MAPPING TABLE')).toBe(base);
  });

  it('differs when the wording differs', () => {
    expect(itemKey('Ana to draft the mapping table')).not.toBe(
      itemKey('Ravi to draft the mapping table'),
    );
    // A tick should not carry over to a different item that happens to be a prefix.
    expect(itemKey('Ana to draft')).not.toBe(itemKey('Ana to draft the mapping table'));
  });

  it('does not collide across a realistic set of items', () => {
    const items = [
      "I'll do it. — Speaker 1",
      'We will go to the system and see what happens if we add admin. — Speaker 3',
      'So, where file i will give you — Speaker 3',
      'So, for that i will send you — Speaker 2',
      'We will share it again. — Speaker 4',
      'Ana will draft the mapping table and send it round tomorrow.',
      'Ravi will check with finance about reissuing the orders.',
    ];
    expect(new Set(items.map(itemKey)).size).toBe(items.length);
  });
});
