import type { Meeting } from '../../pipeline/types';

/**
 * The item-migration sweep's control loop.
 *
 * Everything interesting about this loop is module-level state — a latch on the meeting count and
 * a `running` flag — and none of it is visible from the store's public surface. That is exactly
 * the kind of code that looks right and is wrong: a latch set on a pass that did NOT drain the
 * backlog silently stops the sweep forever, and the symptom is not an error but a worklist that
 * says "0 outstanding" and means "I gave up". So each test here re-requires the module to get a
 * fresh latch, and asserts on the number of native calls rather than on anything rendered.
 *
 * `setTimeout` is replaced with an immediate call rather than driven by fake timers: the loop
 * yields 60 ms between passes and the MAX_PASSES test runs four hundred of them, which is 24
 * seconds of real time for a property that has nothing to do with wall-clock. The yield ITSELF is
 * pinned by its own test, on the argument rather than the delay.
 */
const mockBackfillItems = jest.fn<Promise<number>, [number]>();

jest.mock('../../db/queries', () => ({
  db: { backfillItems: (limit: number) => mockBackfillItems(limit) },
}));

/** How many meetings the store thinks the library holds — the value the latch compares. */
function withMeetings(store: { setState: (s: Partial<{ meetings: Meeting[] }>) => void }, n: number) {
  store.setState({ meetings: Array.from({ length: n }, () => ({}) as Meeting) });
}

interface StoreHandle {
  setState: (s: Partial<{ meetings: Meeting[] }>) => void;
  getState: () => { backfillItems: () => Promise<boolean> };
}

/**
 * A copy of the store with its module-level latch unset.
 *
 * `jest.resetModules()` is what makes each test independent: `sweptAtCount` and `running` live in
 * the module's own scope on purpose (putting them in the store would re-render every subscriber
 * whenever the sweep breathed), so importing once at the top of this file would let the first
 * test's latch decide the second test's outcome.
 */
function freshStore(): StoreHandle {
  jest.resetModules();
  return require('../libraryStore').useLibraryStore as StoreHandle;
}

let setTimeoutSpy: jest.SpyInstance;

beforeEach(() => {
  mockBackfillItems.mockReset();
  setTimeoutSpy = jest
    .spyOn(global, 'setTimeout')
    .mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
});

afterEach(() => setTimeoutSpy.mockRestore());

describe('libraryStore.backfillItems', () => {
  it('keeps calling native until the backlog reaches zero', async () => {
    mockBackfillItems.mockResolvedValueOnce(20).mockResolvedValueOnce(8).mockResolvedValueOnce(0);
    const store = freshStore();
    withMeetings(store, 40);

    await store.getState().backfillItems();

    expect(mockBackfillItems).toHaveBeenCalledTimes(3);
  });

  it('hands native a bounded batch rather than the whole library', async () => {
    mockBackfillItems.mockResolvedValue(0);
    const store = freshStore();
    withMeetings(store, 4000);

    await store.getState().backfillItems();

    const [limit] = mockBackfillItems.mock.calls[0];
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(25);
  });

  /**
   * The latch. Without it every focus re-asks native a question whose answer cannot have changed,
   * on a library where the answer costs a scan.
   */
  it('short-circuits on the next focus when the meeting count has not moved', async () => {
    mockBackfillItems.mockResolvedValue(0);
    const store = freshStore();
    withMeetings(store, 12);

    await store.getState().backfillItems();
    await store.getState().backfillItems();

    expect(mockBackfillItems).toHaveBeenCalledTimes(1);
  });

  /**
   * ...and lets go the moment the count moves. This is what makes the sweep self-healing: a
   * restored backup drops a pile of unmigrated meetings in and moves the count, so the very next
   * focus sweeps again without anything having to know a restore happened.
   */
  it('sweeps again once the meeting count moves', async () => {
    mockBackfillItems.mockResolvedValue(0);
    const store = freshStore();
    withMeetings(store, 12);

    await store.getState().backfillItems();
    withMeetings(store, 340);
    await store.getState().backfillItems();

    expect(mockBackfillItems).toHaveBeenCalledTimes(2);
  });

  /**
   * A backlog that stops shrinking is a native side that has stopped making progress. Looping on
   * it forever would burn a phone's battery in a `for` loop nobody can see; the hard stop is what
   * makes that impossible rather than merely unlikely.
   */
  it('stops after MAX_PASSES even while the backlog is still shrinking', async () => {
    let remaining = 10_000;
    mockBackfillItems.mockImplementation(async () => --remaining);
    const store = freshStore();
    withMeetings(store, 10_000);

    await store.getState().backfillItems();

    expect(mockBackfillItems).toHaveBeenCalledTimes(400);
  });

  /**
   * A pass that did not shrink the backlog will not shrink it next time either, so the loop stops
   * — and must stop WITHOUT latching. Latching there is the bug this test exists for: the sweep
   * would be switched off permanently by one transient failure, and the screens it feeds would go
   * on claiming a number they had no way to compute.
   */
  it('breaks on a backlog that did not shrink, and retries on the next focus', async () => {
    mockBackfillItems.mockResolvedValue(7);
    const store = freshStore();
    withMeetings(store, 30);

    await store.getState().backfillItems();
    expect(mockBackfillItems).toHaveBeenCalledTimes(2);

    await store.getState().backfillItems();
    expect(mockBackfillItems).toHaveBeenCalledTimes(4);
  });

  /**
   * A rejection is not a latch either, for the same reason and one more: what fails here is
   * loading the native core on a phone still downloading libonnxruntime.so, which is temporary by
   * definition.
   */
  it('does not latch when native rejects', async () => {
    mockBackfillItems.mockRejectedValueOnce(new Error('libaudionotes.so not loaded'));
    const store = freshStore();
    withMeetings(store, 30);

    await expect(store.getState().backfillItems()).resolves.toBe(true);
    mockBackfillItems.mockResolvedValue(0);
    await store.getState().backfillItems();

    expect(mockBackfillItems).toHaveBeenCalledTimes(2);
  });

  /** Two focus events must not interleave two loops over one process-wide database connection. */
  it('will not start a second loop while one is running', async () => {
    let release: (n: number) => void = () => {};
    mockBackfillItems.mockImplementationOnce(() => new Promise<number>(r => { release = r; }));
    const store = freshStore();
    withMeetings(store, 30);

    const first = store.getState().backfillItems();
    const second = store.getState().backfillItems();
    release(0);
    await Promise.all([first, second]);

    expect(mockBackfillItems).toHaveBeenCalledTimes(1);
  });

  /**
   * The yield between passes, asserted on the delay rather than on elapsed time. Without it the
   * whole sweep is one synchronous run of promise continuations and a long backlog is a dropped
   * scroll on the screen that started it.
   */
  it('yields to the event loop between passes', async () => {
    mockBackfillItems.mockResolvedValueOnce(9).mockResolvedValueOnce(0);
    const store = freshStore();
    withMeetings(store, 30);

    await store.getState().backfillItems();

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toBe(60);
  });

  /**
   * The return value exists for one caller and one reason: LibraryScreen counts outstanding
   * actions on focus, and on the first focus after an update it counts them BEFORE this sweep has
   * migrated anything — the "0 outstanding" this whole task exists to stop being said. `true`
   * means native was asked and any cross-meeting count taken before now may be stale; `false`
   * means the latch short-circuited and nothing on disk moved.
   */
  it('reports whether it asked native, so a stale count can be re-taken', async () => {
    mockBackfillItems.mockResolvedValue(0);
    const store = freshStore();
    withMeetings(store, 12);

    await expect(store.getState().backfillItems()).resolves.toBe(true);
    await expect(store.getState().backfillItems()).resolves.toBe(false);
  });
});
