import React from 'react';
import renderer, { act } from 'react-test-renderer';
import MeetingScreen from '../MeetingScreen';
import { db } from '../../db/queries';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// `addListener` returns the unsubscribe and records the focus handler so a test can fire it.
const focusHandlers: Array<() => void> = [];
const nav = {
  navigate: jest.fn(),
  goBack: jest.fn(),
  setOptions: jest.fn(),
  addListener: jest.fn((event: string, cb: () => void) => {
    if (event === 'focus') focusHandlers.push(cb);
    return () => {};
  }),
} as any;
const route = { key: 'meeting', name: 'Meeting', params: { meetingId: 'm1' } } as any;

const minute = {
  id: 'min-1',
  meetingId: 'm1',
  kind: 'summary',
  content: 'A short meeting about the report.',
  source: 'llm',
};

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<MeetingScreen navigation={nav} route={route} />);
  });
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  (db.ensureItems as jest.Mock).mockResolvedValue(undefined);
  (db.getMeeting as jest.Mock).mockResolvedValue({
    id: 'm1',
    title: 'Standup',
    createdAt: 1,
    durationMs: 60_000,
    status: 'done',
    tierUsed: 'free',
    language: 'en',
    audioPath: null,
    audioRetained: 1,
  });
  (db.minutes as jest.Mock).mockResolvedValue([minute]);
  (db.items as jest.Mock).mockResolvedValue([]);
  (db.utterances as jest.Mock).mockResolvedValue([]);
  (db.segments as jest.Mock).mockResolvedValue([]);
  (db.speakers as jest.Mock).mockResolvedValue([]);
  (db.edits as jest.Mock).mockResolvedValue([]);
  (db.tagsFor as jest.Mock).mockResolvedValue([]);
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  (db.setSetting as jest.Mock).mockResolvedValue(undefined);
});

/**
 * Opening a meeting is what migrates it.
 *
 * A meeting recorded before the items table existed has no items until `ensureItems` re-runs the
 * rule pass over its stored transcript. The library-wide sweep added in Task 8b does not replace
 * this trigger — it runs on a Library focus, and a meeting opened straight from a notification has
 * not had one — so both remain. These pin the two halves of the per-meeting call: it has to finish
 * before the read, or a just-migrated meeting renders from data that was not there yet; and it must
 * not be able to stop the meeting opening, because the reason it fails is a native core that has
 * not finished downloading, which has nothing to do with reading a meeting.
 */
test('the meeting is migrated before anything reads it', async () => {
  let migrated!: () => void;
  (db.ensureItems as jest.Mock).mockReturnValue(
    new Promise<void>(res => {
      migrated = res;
    }),
  );

  const tree = await render();

  expect(db.ensureItems).toHaveBeenCalledWith('m1');
  expect(db.minutes).not.toHaveBeenCalled();

  await act(async () => migrated());
  expect(db.minutes).toHaveBeenCalledWith('m1');

  await act(async () => tree.unmount());
});

test('a meeting still opens when the migration fails', async () => {
  (db.ensureItems as jest.Mock).mockRejectedValue(new Error('libaudionotes.so not loaded'));

  const tree = await render();

  expect(db.minutes).toHaveBeenCalledWith('m1');
  expect(JSON.stringify(tree.toJSON())).toContain('A short meeting about the report.');

  await act(async () => tree.unmount());
});

/**
 * `refresh` is also a two-second poll while a meeting is still being processed, and `ensureItems`
 * is not free for exactly the meeting that poll is watching: its guard is "has utterances, has no
 * items", which is the state every meeting is in between ASR finishing and the pipeline writing
 * its items. One call per poll would re-run the rule pass over a half-written transcript, again
 * and again, on the phone that is busy writing the real one.
 */
/**
 * Nothing sets `getId` on this screen, so `navigate('Meeting', …)` reuses the mounted one and
 * changes its params — a "Notes ready" notification for another meeting, tapped while this one is
 * open, arrives exactly this way. The memo is keyed on the meeting id because of it: a ref that
 * only remembered "already migrated" would have the read wait on the previous meeting's migration.
 */
test('a param change migrates the meeting now on screen', async () => {
  const tree = await render();
  expect(db.ensureItems).toHaveBeenCalledWith('m1');

  await act(async () => {
    tree.update(
      <MeetingScreen navigation={nav} route={{ ...route, params: { meetingId: 'm2' } } as any} />,
    );
  });

  expect(db.ensureItems).toHaveBeenCalledWith('m2');
  expect(db.ensureItems).toHaveBeenCalledTimes(2);
  await act(async () => tree.unmount());
});

test('the migration is attempted once per opening, not once per poll', async () => {
  jest.useFakeTimers();
  try {
    (db.minutes as jest.Mock).mockResolvedValue([]);
    const tree = await render();

    expect(db.minutes).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });

    expect((db.minutes as jest.Mock).mock.calls.length).toBeGreaterThan(1);
    expect(db.ensureItems).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
  } finally {
    jest.useRealTimers();
  }
});

/**
 * The once-ever Pro offer, and the one entry point it must not fire on.
 *
 * `shouldOfferPaywall` decides WHETHER; these pin WHEN. Opened from inside the app, a first
 * finished meeting gets the sheet after a short delay, over the notes. Opened from the "Your notes
 * are ready" notification — whose text is "tap to see the summary and transcript" — it must not:
 * on the Galaxy A07 that tap landed on a price 900 ms later. The offer is not spent by that visit,
 * so the in-app case still fires afterwards.
 */
describe('the first-meeting Pro offer', () => {
  const trial = require('../../billing/trial');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(trial, 'shouldOfferPaywall').mockResolvedValue(true);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function renderWith(params: Record<string, unknown>) {
    const r = { key: 'meeting', name: 'Meeting', params: { meetingId: 'm1', ...params } } as any;
    await act(async () => {
      renderer.create(<MeetingScreen navigation={nav} route={r} />);
    });
    // Let the offer's promise settle, then its delay elapse.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
  }

  test('opened from inside the app, a finished meeting gets the offer', async () => {
    await renderWith({});
    expect(nav.navigate).toHaveBeenCalledWith('Paywall', { meetingId: 'm1' });
  });

  test('opened from the notes-ready notification, it shows the notes and nothing else', async () => {
    await renderWith({ fromNotification: true });
    expect(nav.navigate).not.toHaveBeenCalledWith('Paywall', expect.anything());
  });
});

/**
 * Coming back to the meeting reloads it.
 *
 * The Speakers screen writes a rename to the database and pops; this screen must read again on
 * that return or the transcript keeps the old label until the meeting is reopened — which is what
 * the Pixel showed. The first focus is the mount and is already loaded; later ones are not.
 */
test('regaining focus reloads the meeting, but the first focus does not load it twice', async () => {
  focusHandlers.length = 0;
  await render();
  const loadsAfterMount = (db.speakers as jest.Mock).mock.calls.length;
  expect(loadsAfterMount).toBeGreaterThan(0);
  expect(focusHandlers.length).toBe(1);

  // The mount's own focus: nothing extra.
  await act(async () => {
    focusHandlers[0]();
  });
  expect((db.speakers as jest.Mock).mock.calls.length).toBe(loadsAfterMount);

  // A return from the Speakers screen: read again.
  await act(async () => {
    focusHandlers[0]();
  });
  expect((db.speakers as jest.Mock).mock.calls.length).toBe(loadsAfterMount + 1);
});

/**
 * Every export format the menu promises must be reachable.
 *
 * The format picker used to be an Alert with five buttons; Android renders three, so on the Pixel
 * "Subtitles (.srt)" and "Cancel" did not exist and the dialog could not be backed out of. It is
 * now the app's own sheet, and this pins the list: all four formats, by name, in one place.
 */
test('the export picker offers all four formats, subtitles included', async () => {
  const { Sheet } = require('../../components/ui');
  const tree = await render();
  const sheets = tree.root.findAllByType(Sheet);
  const picker = sheets.find(s => s.props.title === 'Export minutes');
  expect(picker).toBeDefined();
  expect(picker!.props.actions.map((a: { label: string }) => a.label)).toEqual([
    'PDF', 'Markdown', 'Plain text', 'Subtitles (.srt)',
  ]);
});
