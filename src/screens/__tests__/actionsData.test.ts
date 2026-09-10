import { loadActions } from '../actionsData';
import { db } from '../../db/queries';

jest.mock('../../db/queries');

/**
 * The cross-meeting worklist's tick state.
 *
 * A tick used to be keyed on a hash of the item's TEXT, so re-recognising one word in a
 * reprocessed meeting unticked work somebody had already done. `Reconciler` is what makes the
 * item's id safe to key on instead — it carries the id across a reprocess, and flags rather than
 * guesses when it is unsure. These tests are therefore written against ids, and a test that only
 * passes with a hash is asserting the defect.
 */
const row = (over: Record<string, unknown> = {}) => ({
  meetingId: 'm1',
  meetingTitle: 'Standup',
  createdAt: 1,
  id: 'item-1',
  content: 'Send the report',
  source: 'rule',
  anchorStartMs: 5000,
  ...over,
});

describe('loadActions', () => {
  it('resolves the tick from the item id, not from a hash of its text', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([row()]);
    (db.doneItemIds as jest.Mock).mockResolvedValue(new Set(['m1\u0000item-1']));

    const rows = await loadActions();

    expect(rows[0].done).toBe(true);
    expect(rows[0].id).toBe('item-1');
    expect(rows[0].anchorStartMs).toBe(5000);
  });

  it('does not untick an item whose wording changed', async () => {
    // The same item, one word re-recognised by a later ASR run. Under the text hash this came
    // back unticked and the work looked undone.
    (db.allActions as jest.Mock).mockResolvedValue([row({ content: 'Send the reports' })]);
    (db.doneItemIds as jest.Mock).mockResolvedValue(new Set(['m1\u0000item-1']));

    expect((await loadActions())[0].done).toBe(true);
  });

  it('leaves an item nobody ticked outstanding', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([row()]);
    (db.doneItemIds as jest.Mock).mockResolvedValue(new Set<string>());

    expect((await loadActions())[0].done).toBe(false);
  });

  it('does not carry a tick to the same item id in a different meeting', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([row({ meetingId: 'm2' })]);
    (db.doneItemIds as jest.Mock).mockResolvedValue(new Set(['m1\u0000item-1']));

    expect((await loadActions())[0].done).toBe(false);
  });

  /**
   * The two halves are joined with a NUL, and the whole point of the separator is that it cannot
   * occur in either half. A space can, and the pair below is what that costs: two different
   * (meeting, item) pairs whose halves concatenate to the same string, so one meeting's tick
   * marks another meeting's item done. This test fails on the tick that IS meant to land as well
   * as on the one that is not, so it cannot be satisfied by a space either way.
   */
  it('joins the halves with a separator neither half can contain', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([
      row({ meetingId: 'm1 x', id: 'item-1' }),
      row({ meetingId: 'm1', id: 'x item-1' }),
    ]);
    (db.doneItemIds as jest.Mock).mockResolvedValue(new Set(['m1\u0000x item-1']));

    const rows = await loadActions();

    expect(rows[1].done).toBe(true);
    expect(rows[0].done).toBe(false);
  });
});
