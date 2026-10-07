import React from 'react';
import renderer, { act } from 'react-test-renderer';
import SearchScreen from '../SearchScreen';
import { db } from '../../db/queries';
import Licence from '../../native/NativeLicence';
import { meaningSearchOffer } from '../../billing/allowanceCopy';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const nav = { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as never;
const route = { key: 'search', name: 'Search', params: undefined } as never;

// The markers native wraps around a matched term (see SearchScreen's runsOf). Built with
// fromCharCode: a literal control character in a source file is invisible and easily lost.
const OPEN = String.fromCharCode(2);
const CLOSE = String.fromCharCode(3);

const hits = [
  {
    meetingId: 'm1', kind: 'utterance', refId: 'u2', startMs: 6500,
    snippet: 'Only a draft; the final version needs another week.', score: 0.03, byMeaning: true,
  },
  {
    meetingId: 'm1', kind: 'utterance', refId: 'u1', startMs: 5000,
    snippet: `Can you ${OPEN}push${CLOSE} the proposal?`, score: 0.02,
  },
];

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<SearchScreen navigation={nav} route={route} />);
  });
  return tree;
}
const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAllByType(require('react-native').Text).map(t => [].concat(t.props.children).join(''));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  (db.listMeetings as jest.Mock).mockResolvedValue([{ id: 'm1', title: 'Sync', createdAt: Date.now() }]);
  (db.listArchived as jest.Mock).mockResolvedValue([]);
  (db.allActions as jest.Mock).mockResolvedValue([]);
  (db.search as jest.Mock).mockResolvedValue(hits);
  (db.backfillEmbeddings as jest.Mock).mockResolvedValue(3);
});
afterEach(() => jest.useRealTimers());

async function type(tree: renderer.ReactTestRenderer, term: string) {
  const input = tree.root.findByType(require('react-native').TextInput);
  await act(async () => {
    input.props.onChangeText(term);
    jest.advanceTimersByTime(300);
  });
  await act(async () => {});
}

/**
 * Two things a person sees that did not exist before the meaning index: a hit whose words they
 * did not type, marked so the missing highlight is not a puzzle, and how far the index has got.
 */
describe('SearchScreen — meaning hits', () => {
  it('marks a hit found by meaning alone, and not one found by the words', async () => {
    const tree = await render();
    await type(tree, 'push back');
    const rows = tree.root
      .findAllByProps({ accessibilityRole: 'button' }, { deep: false })
      .map(n => n.props.accessibilityLabel as string)
      .filter(l => typeof l === 'string' && l.startsWith('said'));
    expect(rows).toEqual([
      'said (by meaning): Only a draft; the final version needs another week.',
      'said: Can you push the proposal?',
    ]);
    const marks = tree.root.findAllByProps({ accessibilityLabel: 'found by meaning' }, { deep: false });
    expect(marks).toHaveLength(1);
  });

  it('says how many meetings the meaning index has not reached', async () => {
    const tree = await render();
    expect(db.backfillEmbeddings).toHaveBeenCalledWith(0);
    expect(texts(tree)).toContain('Meaning search is still indexing 3 meetings');
  });

  it('says nothing about indexing when it is done, or on a phone that never indexes', async () => {
    (db.backfillEmbeddings as jest.Mock).mockResolvedValue(0);
    const tree = await render();
    expect(texts(tree).some(t => t.includes('still indexing'))).toBe(false);
  });
});

/**
 * Keyword search is Free (F09, 7 Oct 2026); search by meaning stays Pro. A Free phone gets keyword
 * hits only and one quiet line offering Pro; a Pro phone gets both and no offer.
 */
describe('SearchScreen — Free and Pro', () => {
  const setPaid = (paid: boolean) =>
    (Licence.status as jest.Mock).mockResolvedValue({
      plan: paid ? 'pro' : 'free', state: paid ? 'active' : 'none', paid, expiresAt: 0, account: null, lapsedCopy: '',
    });
  const rowLabels = (tree: renderer.ReactTestRenderer) =>
    tree.root
      .findAllByProps({ accessibilityRole: 'button' }, { deep: false })
      .map(n => n.props.accessibilityLabel as string)
      .filter(l => typeof l === 'string' && l.startsWith('said'));

  it('Free sees the keyword hit and not the meaning hit', async () => {
    setPaid(false);
    const tree = await render();
    await type(tree, 'push back');
    expect(rowLabels(tree)).toEqual(['said: Can you push the proposal?']);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'found by meaning' }, { deep: false })).toHaveLength(0);
  });

  it('Free is offered Pro for search by meaning, once, and the offer opens the paywall', async () => {
    setPaid(false);
    const tree = await render();
    await type(tree, 'push back');
    const offers = texts(tree).filter(t => t === meaningSearchOffer);
    expect(offers).toHaveLength(1);
    const press = tree.root.find(n => n.props.accessibilityLabel === meaningSearchOffer && typeof n.props.onPress === 'function');
    press.props.onPress();
    expect((nav as any).navigate).toHaveBeenCalledWith('Paywall');
  });

  it('Free is not offered anything before a search has been made', async () => {
    setPaid(false);
    const tree = await render();
    expect(texts(tree)).not.toContain(meaningSearchOffer);
  });

  it('until the licence has answered the screen behaves as Free, not as Pro', async () => {
    (Licence.status as jest.Mock).mockReturnValue(new Promise(() => {}));
    const tree = await render();
    await type(tree, 'push back');
    expect(rowLabels(tree)).toEqual(['said: Can you push the proposal?']);
  });

  it('Free never sees the meaning-index progress line', async () => {
    setPaid(false);
    const tree = await render();
    expect(texts(tree).some(t => t.includes('Meaning search is still indexing'))).toBe(false);
  });

  it('Pro sees both kinds of hit and no offer', async () => {
    setPaid(true);
    const tree = await render();
    await type(tree, 'push back');
    expect(rowLabels(tree)).toEqual([
      'said (by meaning): Only a draft; the final version needs another week.',
      'said: Can you push the proposal?',
    ]);
    expect(texts(tree)).not.toContain(meaningSearchOffer);
  });
});
