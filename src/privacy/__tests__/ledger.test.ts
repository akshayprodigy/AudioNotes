jest.mock('../../db/queries', () => ({
  db: { query: jest.fn(), getSetting: jest.fn(), setSetting: jest.fn() },
}));

import { db } from '../../db/queries';
import { record, drops, DROPS_KEY } from '../ledger';

const mockDb = db as unknown as {
  query: jest.Mock;
  getSetting: jest.Mock;
  setSetting: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.mockResolvedValue([]);
  mockDb.getSetting.mockResolvedValue(null);
  mockDb.setSetting.mockResolvedValue(undefined);
});

describe('recording what left the phone', () => {
  it('writes the host, the body bytes and a readable detail', async () => {
    await record({
      kind: 'licence',
      host: 'licence.innocorelabs.com',
      sent: 180,
      received: 620,
      detail: 'token refresh',
    });
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO network_events');
    expect(params).toEqual(
      expect.arrayContaining(['licence', 'licence.innocorelabs.com', 180, 620, 'token refresh']),
    );
  });

  /**
   * The failure that matters. If the write throws, the call still happened — so swallowing it
   * produces a screen that reads LOW, which is the same class of overclaim as stamping a consent
   * record for a room that heard nothing.
   */
  it('counts a failed write instead of losing it', async () => {
    mockDb.query.mockRejectedValue(new Error('database is locked'));
    await record({ kind: 'licence', host: 'h', sent: 1, received: 1, detail: null });
    expect(mockDb.setSetting).toHaveBeenCalledWith(DROPS_KEY, '1');
  });

  it('never lets recording break the call it is recording', async () => {
    mockDb.query.mockRejectedValue(new Error('database is locked'));
    mockDb.setSetting.mockRejectedValue(new Error('also broken'));
    // Both storage paths dead, and this still must not throw into a licence refresh.
    await expect(
      record({ kind: 'licence', host: 'h', sent: 1, received: 1, detail: null }),
    ).resolves.toBeUndefined();
  });

  it('reports how many events went unrecorded', async () => {
    mockDb.getSetting.mockResolvedValue('3');
    expect(await drops()).toBe(3);
  });

  it('reports no drops when nothing has ever failed', async () => {
    mockDb.getSetting.mockResolvedValue(null);
    expect(await drops()).toBe(0);
  });
});
