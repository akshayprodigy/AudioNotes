import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ReviewScreen from '../ReviewScreen';
import { db } from '../../db/queries';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../meeting/usePlayer', () => ({
  usePlayer: () => ({ available: false, playFrom: jest.fn(), positionMs: 0 }),
}));

const nav = { navigate: jest.fn(), goBack: jest.fn() } as any;
const route = { key: 'review', name: 'Review', params: { meetingId: 'm1' } } as any;

const base = {
  meetingId: 'm1',
  kind: 'action',
  genVersion: 'rules@3+qwen2.5-1.5b/classify@1',
  anchorStartMs: 5000,
  anchorEndMs: 6000,
  sources: [{ startMs: 5000, endMs: 6000, charStart: 0, charEnd: 10, utteranceId: 'u1' }],
};
const items = [
  {
    ...base, id: 'i1', text: 'Can you send the proposal Friday? — Unassigned', review: 'needs_review',
    itemType: 'request', status: 'contradicted', ownerJson: '{"kind":"unassigned"}', dateSaid: 'Friday', dateNorm: null,
  },
  {
    ...base, id: 'i2', text: 'Priya will send the deck next week — Priya', review: 'needs_review',
    itemType: 'commitment', status: 'open', ownerJson: '{"kind":"person","name":"Priya","confidence":"high"}',
    dateSaid: 'next week', dateNorm: null,
  },
  { ...base, id: 'i3', text: 'Ship it — Rahul', review: 'suggested', itemType: 'commitment', status: 'open', ownerJson: null, dateSaid: null, dateNorm: null },
  // The Reconciler's ambiguous-match flag on an item nothing has classified: not the model's doubt.
  { ...base, id: 'i4', text: 'Moved? — Unassigned', review: 'needs_review', itemType: null, status: null, ownerJson: null, dateSaid: null, dateNorm: null },
];
const utterances = [
  { id: 'u1', meetingId: 'm1', startMs: 5000, endMs: 6000, speakerId: 's1', text: 'Can you send the proposal Friday?' },
  { id: 'u2', meetingId: 'm1', startMs: 6500, endMs: 9000, speakerId: 's2', text: 'Only a draft; the final version needs another week.' },
];
const speakers = [
  { id: 's1', meetingId: 'm1', clusterLabel: 'S0', displayName: 'Priya' },
  { id: 's2', meetingId: 'm1', clusterLabel: 'S1', displayName: 'Rahul' },
];

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ReviewScreen navigation={nav} route={route} />);
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

beforeEach(() => {
  jest.clearAllMocks();
  (db.items as jest.Mock).mockResolvedValue(items);
  (db.utterances as jest.Mock).mockResolvedValue(utterances);
  (db.speakers as jest.Mock).mockResolvedValue(speakers);
  // 01:00 on Wed 16 Sep in the phone's zone — a moment that is still Tuesday in UTC anywhere east
  // of Greenwich, so a day list that reads the meeting's UTC date leads with the wrong day.
  (db.getMeeting as jest.Mock).mockResolvedValue({ id: 'm1', title: 'Sync', createdAt: new Date(2026, 8, 16, 1, 0).getTime(), durationMs: 60_000 });
  (db.setItemReview as jest.Mock).mockResolvedValue(undefined);
  (db.setItemOwner as jest.Mock).mockResolvedValue(undefined);
  (db.setItemDate as jest.Mock).mockResolvedValue(undefined);
  (db.setItemType as jest.Mock).mockResolvedValue(undefined);
  (db.addSpeaker as jest.Mock).mockResolvedValue({ id: 's9', meetingId: 'm1', clusterLabel: 'human', displayName: 'Meera' });
  (db.edits as jest.Mock).mockResolvedValue([]);
  (db.putEdit as jest.Mock).mockResolvedValue(undefined);
});

/**
 * The card flow: one item the model could not settle at a time, three things a person can do.
 * The queue is only the classified needs_review items — i3 is suggested and i4 was never read by
 * the model, and neither appears.
 */
describe('ReviewScreen', () => {
  it('shows the first card with what the model read and why it is here', async () => {
    const tree = await render();
    const t = texts(tree);
    expect(t).toContain('1 of 2');
    expect(t).toContain('Request');
    expect(t).toContain('Contradicted');
    expect(t).toContain('A later turn pushed back on this.');
    // The reply that pushed back, quoted from the transcript.
    expect(t.some(x => x.includes('Only a draft'))).toBe(true);
  });

  /**
   * The classifier's confidence rides inside owner_json (there is no column for it), and a
   * low-confidence reading is in the queue for exactly that reason. Seen on the Pixel, 17 Sep:
   * a card with no reason line at all, because the screen asked the rule with confidence null.
   */
  it('a low-confidence reading says the model was not sure', async () => {
    (db.items as jest.Mock).mockResolvedValue([
      {
        ...base, id: 'i5', text: 'Prey will send the deck tomorrow. — Prey (due tomorrow)', review: 'needs_review',
        itemType: 'commitment', status: 'open', ownerJson: '{"kind":"speaker","id":"s1","confidence":"low"}',
        dateSaid: 'tomorrow', dateNorm: Date.UTC(2026, 8, 18),
      },
    ]);
    const tree = await render();
    expect(texts(tree)).toContain('The model was not sure what this is.');
  });

  it('Confirm keeps the item and advances; the last card goes back', async () => {
    const tree = await render();
    await press(tree, 'Confirm');
    expect(db.setItemReview).toHaveBeenCalledWith('i1', 'confirmed');
    expect(texts(tree)).toContain('2 of 2');
    await press(tree, 'Confirm');
    expect(db.setItemReview).toHaveBeenCalledWith('i2', 'confirmed');
    expect(nav.goBack).toHaveBeenCalled();
  });

  it('Not an item rejects it', async () => {
    const tree = await render();
    await press(tree, 'Not an item');
    expect(db.setItemReview).toHaveBeenCalledWith('i1', 'rejected');
  });

  it('Fix on an owner-less action opens the speaker picker and writes the owner', async () => {
    const tree = await render();
    await press(tree, 'Fix');
    await press(tree, 'Who owns it');
    // The picker asks who OWNS it, not who said it — the transcript's question is not this one.
    expect(texts(tree).some(t => t.startsWith('Who owns'))).toBe(true);
    expect(texts(tree).some(t => t.startsWith('Who said'))).toBe(false);
    await press(tree, 'Rahul');
    expect(db.setItemOwner).toHaveBeenCalledWith('i1', JSON.stringify({ kind: 'speaker', id: 's2', confidence: 'high' }));
    // And the correction every tab and export already honour: the text says who, now.
    expect(db.putEdit).toHaveBeenCalledWith('m1', 'item', 'i1', 'Can you send the proposal Friday? — Rahul');
  });

  it('an owner fix keeps an earlier correction of the words and the due date, and replaces its owner', async () => {
    (db.edits as jest.Mock).mockResolvedValue([
      { meetingId: 'm1', targetKind: 'item', targetKey: 'i1', content: 'Send the proposal — Priya (due Friday)' },
    ]);
    const tree = await render();
    await press(tree, 'Fix');
    await press(tree, 'Who owns it');
    await press(tree, 'Rahul');
    expect(db.putEdit).toHaveBeenCalledWith('m1', 'item', 'i1', 'Send the proposal — Rahul (due Friday)');
  });

  it('a typed name becomes a speaker row, the owner, and the correction', async () => {
    const tree = await render();
    await press(tree, 'Fix');
    await press(tree, 'Who owns it');
    await press(tree, 'Someone new');
    const prompt = tree.root.findAllByProps({ title: 'Who owns it?' }, { deep: false })[0];
    await act(async () => {
      prompt.props.onSubmit('Meera', '');
    });
    expect(db.addSpeaker).toHaveBeenCalledWith('m1', 'Meera');
    expect(db.setItemOwner).toHaveBeenCalledWith('i1', JSON.stringify({ kind: 'speaker', id: 's9', confidence: 'high' }));
    expect(db.putEdit).toHaveBeenCalledWith('m1', 'item', 'i1', 'Can you send the proposal Friday? — Meera');
  });

  it('Fix on an unpinned date offers days from the meeting date, and No date', async () => {
    const tree = await render();
    await press(tree, 'Confirm'); // to card 2, whose reason is the date
    await press(tree, 'Fix');
    await press(tree, 'Which day');
    // The meeting was Wed 16 Sep: its own day leads, and nothing earlier is offered.
    const t = texts(tree);
    expect(t).toContain('Wed 16 Sep');
    expect(t).not.toContain('Tue 15 Sep');
    await press(tree, 'Thu 17 Sep');
    expect(db.setItemDate).toHaveBeenCalledWith('i2', expect.any(Number));
    const [, ms] = (db.setItemDate as jest.Mock).mock.calls[0];
    // The shape date_norm holds everywhere: UTC midnight of the calendar day, never a local one.
    expect(new Date(ms).toISOString().slice(0, 10)).toBe('2026-09-17');
    expect(ms % 86_400_000).toBe(0);
  });

  it('No date writes null', async () => {
    const tree = await render();
    await press(tree, 'Confirm');
    await press(tree, 'Fix');
    await press(tree, 'Which day');
    await press(tree, 'No date');
    expect(db.setItemDate).toHaveBeenCalledWith('i2', null);
  });
});
