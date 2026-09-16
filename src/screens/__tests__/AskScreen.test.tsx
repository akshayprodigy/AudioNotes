import React from 'react';
import renderer, { act } from 'react-test-renderer';
import AskScreen from '../AskScreen';
import { db } from '../../db/queries';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../native/NativeLlm', () => ({
  __esModule: true,
  default: { unload: jest.fn(() => Promise.resolve()) },
}));
import Llm from '../../native/NativeLlm';

const nav = { navigate: jest.fn(), goBack: jest.fn() } as any;
const route = { key: 'ask', name: 'Ask', params: { meetingId: 'm1' } } as any;

const past = [
  {
    id: 'a1',
    question: 'when is the proposal due?',
    answer: 'A draft goes Friday [1]; the final needs another week [2].',
    cites: [
      { n: 1, refId: 'u1', startMs: 5000, speaker: 'Priya' },
      { n: 2, refId: 'u2', startMs: 6500, speaker: 'Rahul' },
    ],
    askedAt: 1,
  },
];

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<AskScreen navigation={nav} route={route} />);
  });
  return tree;
}
const press = async (tree: renderer.ReactTestRenderer, label: string) => {
  const n = tree.root.findAllByProps({ accessibilityLabel: label }, { deep: false })[0];
  if (!n) throw new Error(`no node labelled ${label}`);
  await act(async () => {
    n.props.onPress();
  });
};
const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAllByType(require('react-native').Text).map(t => [].concat(t.props.children).join(''));
async function typeAndAsk(tree: renderer.ReactTestRenderer, q: string) {
  const input = tree.root.findByProps({ placeholder: 'Ask this meeting…' });
  await act(async () => {
    input.props.onChangeText(q);
  });
  await press(tree, 'Ask');
}

beforeEach(() => {
  jest.clearAllMocks();
  (db.asks as jest.Mock).mockResolvedValue([]);
  (db.getMeeting as jest.Mock).mockResolvedValue({ id: 'm1', title: 'Sync', createdAt: 1, durationMs: 60_000 });
});

/**
 * A thread of answers that point at the transcript. The defects it guards: an answer with no
 * way back to the moment it came from, a refusal shown as an empty answer, a free user asked to
 * find a model they cannot download, and the writer left resident after the screen is gone.
 */
describe('AskScreen', () => {
  it('shows the meeting’s past asks with their citations', async () => {
    (db.asks as jest.Mock).mockResolvedValue(past);
    const tree = await render();
    const t = texts(tree);
    expect(t).toContain('when is the proposal due?');
    expect(t.some(x => x.includes('A draft goes Friday'))).toBe(true);
    expect(t).toContain('[1] Priya · 0:05');
    expect(t).toContain('[2] Rahul · 0:06');
  });

  it('a citation opens the transcript at that moment', async () => {
    (db.asks as jest.Mock).mockResolvedValue(past);
    const tree = await render();
    await press(tree, 'Play [2] Rahul at 0:06');
    expect(nav.navigate).toHaveBeenCalledWith('Meeting', { meetingId: 'm1', tab: 'transcript', atMs: 6500 });
  });

  it('sending a question asks the meeting and appends the answer', async () => {
    (db.ask as jest.Mock).mockResolvedValue({
      id: 'a2', refusal: null, answer: 'Friday [1].', nothing: false,
      cites: [{ n: 1, refId: 'u1', startMs: 5000, speaker: 'Priya' }],
    });
    const tree = await render();
    await typeAndAsk(tree, 'when?');
    expect(db.ask).toHaveBeenCalledWith('m1', 'when?');
    const t = texts(tree);
    expect(t).toContain('when?');
    expect(t.some(x => x.includes('Friday [1].'))).toBe(true);
    expect(t).toContain('[1] Priya · 0:05');
  });

  it('a nothing answer shows the phrase over the closest passages', async () => {
    (db.ask as jest.Mock).mockResolvedValue({
      id: 'a3', refusal: null, answer: 'Nothing in this meeting settles that.', nothing: true,
      cites: [{ n: 1, refId: 'u1', startMs: 5000, speaker: 'Priya' }],
    });
    const tree = await render();
    await typeAndAsk(tree, 'who won the cup?');
    const t = texts(tree);
    expect(t).toContain('Nothing in this meeting settles that.');
    expect(t).toContain('Closest passages');
    expect(t).toContain('[1] Priya · 0:05');
  });

  it('a refusal for a free user opens the paywall', async () => {
    (db.ask as jest.Mock).mockResolvedValue({ refusal: 'NOT_PRO', id: null, answer: '', cites: [], nothing: true });
    const tree = await render();
    await typeAndAsk(tree, 'when?');
    expect(nav.navigate).toHaveBeenCalledWith('Paywall', { meetingId: 'm1' });
  });

  it('BUSY and NO_MODEL say so in the thread', async () => {
    (db.ask as jest.Mock).mockResolvedValueOnce({ refusal: 'BUSY', id: null, answer: '', cites: [], nothing: true });
    const tree = await render();
    await typeAndAsk(tree, 'when?');
    expect(texts(tree)).toContain('The writer is busy with a meeting — try again in a minute.');
    (db.ask as jest.Mock).mockResolvedValueOnce({ refusal: 'NO_MODEL', id: null, answer: '', cites: [], nothing: true });
    await typeAndAsk(tree, 'when?');
    expect(texts(tree)).toContain('Install the writer and the meaning index in Settings to ask.');
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('an empty question is not sent', async () => {
    const tree = await render();
    await typeAndAsk(tree, '   ');
    expect(db.ask).not.toHaveBeenCalled();
  });

  it('leaving the screen releases the writer', async () => {
    const tree = await render();
    await act(async () => {
      tree.unmount();
    });
    expect(Llm.unload).toHaveBeenCalled();
  });
});
