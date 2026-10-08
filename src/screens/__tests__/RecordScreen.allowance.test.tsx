import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, PermissionsAndroid, ScrollView } from 'react-native';
import RecordScreen from '../RecordScreen';
import { db } from '../../db/queries';
import Licence from '../../native/NativeLicence';
import AudioPipeline from '../../native/NativeAudioPipeline';
import { useRecordingStore } from '../../state/recordingStore';
import { refreshAllowance, useAllowanceStore } from '../../billing/allowance';
import { exhaustedCopy, exhaustedHint, remainingCopy } from '../../billing/allowanceCopy';
import Mascot from '../../components/Mascot';
import { playAvailable, playPlans } from '../../billing/subscription';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../billing/subscription', () => ({
  __esModule: true,
  playAvailable: jest.fn().mockResolvedValue(false),
  playPlans: jest.fn().mockResolvedValue([]),
  buyWithPlay: jest.fn(),
}));

const allowance = Licence.allowance as unknown as jest.Mock;
const FREE = { limit: 5, used: 2, remaining: 3, period: '2026-10', resetsOn: '2026-11-01', paid: false };
const nav = { navigate: jest.fn(), goBack: jest.fn(), reset: jest.fn() } as any;

const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<RecordScreen navigation={nav} route={{ key: 'r', name: 'Record' } as any} />);
  });
  await act(async () => {});
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  useAllowanceStore.setState({ status: null });
  useRecordingStore.setState({ isRecording: false, sessionId: null });
  (db.getSetting as jest.Mock).mockImplementation(async (k: string) => (k === 'consentAck' ? '1' : null));
  (db.setSetting as jest.Mock).mockResolvedValue(undefined);
  (PermissionsAndroid.requestMultiple as jest.Mock | undefined)?.mockResolvedValue?.({});
  jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({
    'android.permission.RECORD_AUDIO': 'granted',
    'android.permission.POST_NOTIFICATIONS': 'granted',
  } as any);
  allowance.mockResolvedValue(FREE);
  // The screen's own idea of "Free" (the length hint) comes from the licence, not the ledger.
  (Licence.status as jest.Mock).mockResolvedValue({
    plan: 'free', state: 'none', paid: false, expiresAt: 0, account: null, lapsedCopy: '',
  });
});

/** The mic button is the one whose press starts a recording. */
const tapRecord = async (tree: renderer.ReactTestRenderer) => {
  const mic = tree.root.find(n => typeof n.props.onPress === 'function' && n.props.size === 148);
  await act(async () => {
    await mic.props.onPress();
  });
};

test('a Free phone with meetings left sees the quiet line and no card', async () => {
  const tree = await render();
  expect(texts(tree)).toContain(remainingCopy(3, 5, '2026-11-01'));
  expect(texts(tree).some(t => t.startsWith("You've used"))).toBe(false);
  expect(texts(tree)).toContain('Tap to start recording · up to 1 hour on Free');
  await act(async () => tree.unmount());
});

test('a Pro phone sees no allowance copy at all', async () => {
  allowance.mockResolvedValue({ ...FREE, paid: true });
  const tree = await render();
  expect(texts(tree).some(t => /free meetings|You've used/.test(t))).toBe(false);
  await act(async () => tree.unmount());
});

test('a spent allowance shows the exhausted card with an upgrade button before any tap', async () => {
  allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0 });
  const tree = await render();
  expect(texts(tree)).toContain(exhaustedCopy('2026-11-01'));
  await act(async () => tree.unmount());
});

// Nothing A069: the exhausted card sat in the same scrolling band as the mascot and cut its head off
// under the Meeting/Dictation switch, and the hint under the clock still said "Tap to start recording".
test('a spent allowance replaces the mascot with the card, and the hint stops inviting a tap', async () => {
  allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0 });
  const tree = await render();
  expect(tree.root.findAllByType(Mascot)).toHaveLength(0);
  expect(texts(tree)).toContain(exhaustedHint('2026-11-01'));
  expect(texts(tree).some(t => t.startsWith('Tap to start recording'))).toBe(false);
  await act(async () => tree.unmount());
});

test('with meetings left the mascot and the invitation are still there', async () => {
  const tree = await render();
  expect(tree.root.findAllByType(Mascot)).toHaveLength(1);
  expect(texts(tree).some(t => t === exhaustedHint('2026-11-01'))).toBe(false);
  await act(async () => tree.unmount());
});

test('a start that native refuses shows the exhausted card with the reset date it sent', async () => {
  (AudioPipeline.start as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error('2026-12-01'), { code: 'allowance_exhausted' }),
  );
  const tree = await render();
  await tapRecord(tree);
  expect(texts(tree)).toContain(exhaustedCopy('2026-12-01'));
  expect(useRecordingStore.getState().isRecording).toBe(false);
  await act(async () => tree.unmount());
});

test('the card is the way to Pro', async () => {
  allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0 });
  const tree = await render();
  // SoftButton is the element carrying the label and the handler; its Raised passes the press down.
  const upgrade = tree.root.find(n => n.props.label === 'Get Pro' && typeof n.props.onPress === 'function');
  await act(async () => upgrade.props.onPress());
  expect(nav.navigate).toHaveBeenCalledWith('Paywall');
  await act(async () => tree.unmount());
});

test('a start refused because an import is running says to finish the import first', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (AudioPipeline.start as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error('Finish the import first'), { code: 'import_in_progress' }),
  );
  const tree = await render();
  await tapRecord(tree);
  expect(alert).toHaveBeenCalledWith('Could not start recording', 'Finish the import first');
  await act(async () => tree.unmount());
});

test('while recording, the allowance line steps aside for the recording', async () => {
  (AudioPipeline.currentSession as jest.Mock).mockResolvedValueOnce({
    isRecording: true, meetingId: 'live', elapsedMs: 5000, silenced: false, paused: false,
  });
  const tree = await render();
  expect(useRecordingStore.getState().isRecording).toBe(true);
  expect(texts(tree).some(t => /free meetings left|You've used/.test(t))).toBe(false);
  await act(async () => tree.unmount());
});

test('buying Pro after a refusal takes the card away', async () => {
  (AudioPipeline.start as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error('2026-11-01'), { code: 'allowance_exhausted' }),
  );
  allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0 });
  const tree = await render();
  await tapRecord(tree);
  expect(texts(tree)).toContain(exhaustedCopy('2026-11-01'));
  allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0, paid: true });
  await act(async () => {
    await refreshAllowance();
  });
  expect(texts(tree).some(t => /You've used/.test(t))).toBe(false);
  await act(async () => tree.unmount());
});

// ---------------------------------------------------------------------------------------------
// F07 - the stage. The react-test-renderer has no layout engine, so these tests pin the STRUCTURE
// that makes the layout safe (what is in the scrolling band and what is not); that the controls are
// actually on screen at 384x853 dp and font scale 2.0 is a device check.
// ---------------------------------------------------------------------------------------------

const MIN = 60 * 1000;
const recordingFor = (elapsedMs: number) =>
  (AudioPipeline.currentSession as jest.Mock).mockResolvedValueOnce({
    isRecording: true, meetingId: 'live', elapsedMs, silenced: false, paused: false,
  });

const within = (scroll: renderer.ReactTestInstance, node: renderer.ReactTestInstance) =>
  scroll.findAll(n => n === node).length > 0;
const inAnyScroll = (tree: renderer.ReactTestRenderer, node: renderer.ReactTestInstance) =>
  tree.root.findAllByType(ScrollView).some(sv => within(sv, node));
const bigControl = (tree: renderer.ReactTestRenderer) =>
  tree.root.find(n => typeof n.props.onPress === 'function' && n.props.size === 148);
const labelled = (tree: renderer.ReactTestRenderer, label: string) =>
  tree.root.find(n => n.props.label === label && typeof n.props.onPress === 'function');
const mascots = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(Mascot);
const cardText = (tree: renderer.ReactTestRenderer) =>
  tree.root.find(n => Array.isArray(n.props.children) && /left on Free/.test(n.props.children.join('')));

test('while recording normally the mascot is shown and the stop control is not in a scroll view', async () => {
  recordingFor(5 * 1000);
  const tree = await render();
  expect(mascots(tree)).toHaveLength(1);
  expect(inAnyScroll(tree, bigControl(tree))).toBe(false);
  expect(inAnyScroll(tree, labelled(tree, 'Pause'))).toBe(false);
  expect(inAnyScroll(tree, labelled(tree, 'Mark'))).toBe(false);
  expect(tree.root.findAll(n => Array.isArray(n.props.children) && /left on Free/.test(n.props.children.join(''))))
    .toHaveLength(0);
  await act(async () => tree.unmount());
});

test('the first seconds of a recording ask for a pause for the announcement, then go back to listening', async () => {
  recordingFor(2 * 1000);
  const tree = await render();
  expect(texts(tree)).toContain('Announcing the recording — start speaking after it');
  expect(texts(tree)).not.toContain('Listening — tap to finish');
  await act(async () => tree.unmount());
  recordingFor(20 * 1000);
  const later = await render();
  expect(texts(later)).toContain('Listening — tap to finish');
  expect(texts(later).some(t => /Announcing/.test(t))).toBe(false);
  await act(async () => later.unmount());
});

test('in the warning phase the card replaces the mascot, inside the scrolling band, and the controls stay fixed', async () => {
  recordingFor(56 * MIN);
  const tree = await render();
  expect(mascots(tree)).toHaveLength(0);
  const scrolls = tree.root.findAllByType(ScrollView);
  expect(scrolls.length).toBeGreaterThan(0);
  expect(scrolls.some(sv => within(sv, cardText(tree)))).toBe(true);
  expect(inAnyScroll(tree, bigControl(tree))).toBe(false);
  expect(inAnyScroll(tree, labelled(tree, 'Pause'))).toBe(false);
  expect(inAnyScroll(tree, labelled(tree, 'Mark'))).toBe(false);
  await act(async () => tree.unmount());
});

test("the warning card's own button stays inside the card, in the scrolling band", async () => {
  (playAvailable as jest.Mock).mockResolvedValueOnce(true);
  (playPlans as jest.Mock).mockResolvedValueOnce([
    { basePlanId: 'monthly', price: '$4.99', priceMicros: 4990000, period: 'P1M', fullPrice: null, trialPeriod: 'P1W', trialCycles: 1 },
  ]);
  recordingFor(56 * MIN);
  const tree = await render();
  const button = tree.root.find(
    n => typeof n.props.label === 'string' && n.props.label.startsWith('Keep recording') && typeof n.props.onPress === 'function',
  );
  expect(tree.root.findAllByType(ScrollView).some(sv => within(sv, button) && within(sv, cardText(tree)))).toBe(true);
  await act(async () => tree.unmount());
});

test('at idle the mascot is shown and the start control is not in a scroll view', async () => {
  const tree = await render();
  expect(mascots(tree)).toHaveLength(1);
  expect(inAnyScroll(tree, bigControl(tree))).toBe(false);
  await act(async () => tree.unmount());
});

test('with the allowance spent the card is in the scrolling band and the start control is not', async () => {
  allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0 });
  const tree = await render();
  const get = labelled(tree, 'Get Pro');
  expect(tree.root.findAllByType(ScrollView).some(sv => within(sv, get))).toBe(true);
  expect(inAnyScroll(tree, bigControl(tree))).toBe(false);
  await act(async () => tree.unmount());
});

// ---------------------------------------------------------------------------------------------
// F13 - the explanation of an ending that was not the person's own Stop, kept until acknowledged.
// ---------------------------------------------------------------------------------------------

const DAY = 24 * 60 * MIN;
function newestMeeting(over: Record<string, unknown> = {}, acked = false) {
  const m = { id: 'm1', createdAt: Date.now() - DAY, durationMs: 40 * MIN, endReason: 'mic_lost', ...over };
  (db.listMeetings as jest.Mock).mockResolvedValue([{ id: m.id }]);
  (db.getMeeting as jest.Mock).mockResolvedValue(m);
  (db.getSetting as jest.Mock).mockImplementation(async (k: string) =>
    k === 'consentAck' ? '1' : k === `ending_ack.${m.id}` && acked ? '1' : null,
  );
  return m;
}
const MIC_LOST = 'Stopped early: a call or another app took the microphone. Everything up to that point is kept.';
const hasButton = (tree: renderer.ReactTestRenderer, label: string) =>
  tree.root.findAll(n => n.props.label === label && typeof n.props.onPress === 'function').length > 0;
const dismiss = (tree: renderer.ReactTestRenderer) =>
  tree.root.find(n => n.props.accessibilityLabel === 'Dismiss' && typeof n.props.onPress === 'function');

describe('ending card', () => {
  beforeEach(() => {
    (db.listMeetings as jest.Mock).mockResolvedValue([]);
    (db.getMeeting as jest.Mock).mockResolvedValue(undefined);
  });

  test('a meeting that ended for a reason other than Stop is explained once, above the mascot', async () => {
    newestMeeting();
    const tree = await render();
    expect(texts(tree)).toContain(MIC_LOST);
    expect(hasButton(tree, 'Open the meeting')).toBe(true);
    expect(tree.root.findAllByType(ScrollView).some(sv => within(sv, dismiss(tree)))).toBe(true);
    await act(async () => tree.unmount());
  });

  test('every non-Stop reason shows its own sentence', async () => {
    for (const r of ['cap_reached', 'mic_lost', 'mic_unavailable', 'disk_full', 'write_failed', 'pause_timeout']) {
      newestMeeting({ endReason: r });
      const tree = await render();
      expect(texts(tree).some(t => /Everything up to that point is kept\.$/.test(t))).toBe(true);
      await act(async () => tree.unmount());
    }
  });

  test('Dismiss acknowledges the meeting and takes the card away', async () => {
    newestMeeting();
    const tree = await render();
    await act(async () => dismiss(tree).props.onPress());
    expect(db.setSetting).toHaveBeenCalledWith('ending_ack.m1', '1');
    expect(texts(tree)).not.toContain(MIC_LOST);
    expect(nav.reset).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  test('Open the meeting acknowledges it and opens it', async () => {
    newestMeeting();
    const tree = await render();
    await act(async () => labelled(tree, 'Open the meeting').props.onPress());
    expect(db.setSetting).toHaveBeenCalledWith('ending_ack.m1', '1');
    expect(nav.reset).toHaveBeenCalledWith({
      index: 1,
      routes: [{ name: 'Library' }, { name: 'Meeting', params: { meetingId: 'm1' } }],
    });
    await act(async () => tree.unmount());
  });

  test('an acknowledged ending does not come back', async () => {
    newestMeeting({}, true);
    const tree = await render();
    expect(texts(tree)).not.toContain(MIC_LOST);
    await act(async () => tree.unmount());
  });

  test('a normal Stop shows nothing', async () => {
    newestMeeting({ endReason: 'stopped' });
    const tree = await render();
    expect(hasButton(tree, 'Open the meeting')).toBe(false);
    expect(texts(tree).some(t => /Everything up to that point|nothing was recorded/.test(t))).toBe(false);
    await act(async () => tree.unmount());
  });

  test('a meeting older than a week shows nothing', async () => {
    newestMeeting({ createdAt: Date.now() - 8 * DAY });
    const tree = await render();
    expect(texts(tree)).not.toContain(MIC_LOST);
    await act(async () => tree.unmount());
  });

  test('the Free-limit ending is not shown to a phone that is Pro now', async () => {
    newestMeeting({ endReason: 'cap_reached' });
    (Licence.status as jest.Mock).mockResolvedValue({
      plan: 'pro', state: 'active', paid: true, expiresAt: 0, account: null, lapsedCopy: '',
    });
    const tree = await render();
    expect(texts(tree).some(t => /Free limit/.test(t))).toBe(false);
    await act(async () => tree.unmount());
  });

  test('an ending where nothing was recorded explains but has nothing to open', async () => {
    newestMeeting({ endReason: 'mic_unavailable', durationMs: 0 });
    const tree = await render();
    expect(texts(tree)).toContain('The microphone could not be opened, so nothing was recorded.');
    expect(hasButton(tree, 'Open the meeting')).toBe(false);
    await act(async () => tree.unmount());
  });

  test('no meetings, or a failing database, shows nothing and does not crash', async () => {
    (db.listMeetings as jest.Mock).mockRejectedValue(new Error('locked'));
    const tree = await render();
    expect(hasButton(tree, 'Open the meeting')).toBe(false);
    await act(async () => tree.unmount());
  });

  test('the card is not shown while a recording is running', async () => {
    newestMeeting();
    recordingFor(5 * 1000);
    const tree = await render();
    expect(texts(tree)).not.toContain(MIC_LOST);
    await act(async () => tree.unmount());
  });

  test('the live alert acknowledges the meeting so the card never doubles it', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    newestMeeting({ id: 'live' });
    (AudioPipeline.currentSession as jest.Mock).mockResolvedValueOnce({
      isRecording: true, meetingId: 'live', elapsedMs: 5000, silenced: false, paused: false,
    });
    const tree = await render();
    // The recording ends elsewhere (the Free limit, a lost mic): native emits onCaptureState and
    // the session read now says it is over.
    (AudioPipeline.currentSession as jest.Mock).mockResolvedValueOnce({
      isRecording: false, meetingId: null, elapsedMs: 0, silenced: false, paused: false,
    });
    await act(async () => {
      (global as any).__TEST_EMIT__('onCaptureState', {});
    });
    await act(async () => {});
    expect(alert).toHaveBeenCalledWith('Recording stopped', MIC_LOST, expect.anything());
    expect(db.setSetting).toHaveBeenCalledWith('ending_ack.live', '1');
    expect(texts(tree)).not.toContain(MIC_LOST);
    await act(async () => tree.unmount());
    alert.mockRestore();
  });
});
