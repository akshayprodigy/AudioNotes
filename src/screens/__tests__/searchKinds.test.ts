import { kindMeta } from '../SearchScreen';
import { lightColors } from '../../theme/palette';
import type { SearchHit } from '../../pipeline/types';

/**
 * Every kind of search hit has been thought about.
 *
 * `kindMeta` switches on `SearchHit['kind']` and ends in a `default` branch, which means adding a
 * member to that union is NOT a type error — the new kind falls through and is silently rendered
 * as a TITLE opening the summary tab. That is not hypothetical: `'item'` was indexed by AudioDb a
 * task before anything produced items for real meetings, and the day the pipeline started writing
 * them every decision, action and question in search would have said "TITLE".
 *
 * So the enforcement is in two halves and both are needed:
 *
 *  1. [KINDS] is a `Record` over the union, so a new member fails to COMPILE here until it is
 *     listed — the type error the `default` branch swallows, moved somewhere it cannot be.
 *  2. The labels must all be DISTINCT. A kind that is listed but has no `case` falls through to
 *     'TITLE' and collides with the real title, which is the whole failure in one assertion.
 */
const KINDS: Record<SearchHit['kind'], true> = {
  utterance: true,
  title: true,
  minute: true,
  summary: true,
  item: true,
};

const allKinds = Object.keys(KINDS) as SearchHit['kind'][];

describe('kindMeta', () => {
  it('labels every kind of hit as something different', () => {
    const labels = allKinds.map(k => kindMeta(k, lightColors).label);
    expect(new Set(labels).size).toBe(allKinds.length);
  });

  it('does not render an item as a title', () => {
    // The exact symptom of the missing case, named so the failure reads as the bug.
    expect(kindMeta('item', lightColors).label).not.toBe(kindMeta('title', lightColors).label);
  });

  it('opens an item on a tab that shows decisions, actions and questions', () => {
    // An item hit is one of the three and the hit does not say which, so the summary tab — where
    // an unhandled kind lands — shows none of them.
    expect(kindMeta('item', lightColors).tab).toBe('mom');
  });
});
