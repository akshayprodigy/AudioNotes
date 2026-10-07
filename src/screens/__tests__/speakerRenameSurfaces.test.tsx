import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ActionsTab from '../meeting/ActionsTab';
import MinutesTab from '../meeting/MinutesTab';
import ActionsScreen from '../ActionsScreen';
import ThreadScreen from '../ThreadScreen';
import SearchScreen from '../SearchScreen';
import { db } from '../../db/queries';
import { entitlement } from '../../billing/trial';
import type { Item, Speaker } from '../../pipeline/types';

// F14: renaming a speaker reaches every surface that shows an action's owner. One test per
// surface: render an item whose owner is speaker s1 (the stored text still says "Speaker 1"),
// rename s1, and the new name appears while the old one never does.

jest.mock('../../db/queries');
jest.mock('../../billing/trial', () => ({ __esModule: true, entitlement: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => require('react').useEffect(cb, [cb]),
}));

const OWNER_S1 = JSON.stringify({ kind: 'speaker', id: 's1' });
const STORED = 'Send the report by Friday — Speaker 1 (due Friday)';

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1',
  meetingId: 'm1',
  kind: 'action',
  text: STORED,
  review: 'suggested',
  genVersion: 'rules@1',
  itemType: null,
  status: null,
  ownerJson: OWNER_S1,
  dateSaid: null,
  dateNorm: null,
  anchorStartMs: 5000,
  anchorEndMs: 6000,
  sources: [],
  ...over,
});

const speaker = (displayName: string): Speaker =>
  ({ id: 's1', meetingId: 'm1', clusterLabel: 'S0', displayName, suggestedPerson: null, suggestedName: null });

function strings(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach(n => strings(n, out));
  else if (typeof node === 'object' && 'children' in (node as any)) strings((node as any).children, out);
  return out;
}
const everything = (tree: renderer.ReactTestRenderer) => strings(tree.toJSON()).join(' | ');

async function draw(el: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(el);
  });
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  (db.doneItems as jest.Mock).mockResolvedValue(new Set());
  (db.doneActions as jest.Mock).mockResolvedValue(new Set());
  (db.doneItemIds as jest.Mock).mockResolvedValue(new Set());
  (entitlement as jest.Mock).mockResolvedValue({ paid: true });
});

describe('the Actions tab', () => {
  const tab = (items: Item[], speakers: Speaker[]) =>
    <ActionsTab meetingId="m1" items={items} minutes={[]} speakers={speakers} />;

  it('shows the speaker under the name they have now, and never the old one', async () => {
    const tree = await draw(tab([item()], [speaker('Priya')]));
    const text = everything(tree);
    expect(text).toContain('Priya');
    expect(text).not.toContain('Speaker 1');
    expect(text).toContain('due Friday');
  });

  it('follows a second rename', async () => {
    const tree = await draw(tab([item()], [speaker('Priya')]));
    await act(async () => tree.update(tab([item()], [speaker('Priya Shah')])));
    expect(everything(tree)).toContain('Priya Shah');
  });

  it('leaves a named person and a hand-typed owner alone', async () => {
    const named = item({ id: 'i2', text: 'Send the summary — Maya', ownerJson: null });
    const typed = item({
      id: 'i3',
      text: 'Book the venue — Dana',
      genVersion: 'user',
      anchorStartMs: null,
      ownerJson: JSON.stringify({ kind: 'unassigned' }),
    });
    const text = everything(await draw(tab([named, typed], [speaker('Priya')])));
    expect(text).toContain('Maya');
    expect(text).toContain('Dana');
    expect(text).not.toContain('Priya');
  });

  it('a person-typed edit wins over the stored text but not over a rename of the same speaker', async () => {
    const edits = new Map([['item/i1', 'Send the report, properly — Speaker 1']]);
    const tree = await draw(
      <ActionsTab meetingId="m1" items={[item()]} minutes={[]} speakers={[speaker('Priya')]} edits={edits} />,
    );
    const text = everything(tree);
    expect(text).toContain('properly');
    expect(text).toContain('Priya');
    expect(text).not.toContain('Speaker 1');
  });
});

describe('the Minutes tab', () => {
  it('shows the renamed owner on a document line', async () => {
    const tree = await draw(
      <MinutesTab items={[item()]} minutes={[]} speakers={[speaker('Priya')]} onExport={() => {}} />,
    );
    const text = everything(tree);
    expect(text).toContain('Priya');
    expect(text).not.toContain('Speaker 1');
  });
});

describe('the cross-meeting worklist', () => {
  it('resolves the owner from the speaker row of the item’s own meeting', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([
      {
        meetingId: 'm1', meetingTitle: 'Standup', createdAt: 1, id: 'i1', content: STORED,
        ownerJson: OWNER_S1, source: 'rule', anchorStartMs: 5000,
      },
    ]);
    (db.speakerNames as jest.Mock).mockResolvedValue(new Map([[`m1\u0000s1`, 'Priya']]));
    const tree = await draw(<ActionsScreen navigation={{ navigate: jest.fn() } as any} route={{} as any} />);
    const text = everything(tree);
    expect(text).toContain('Priya');
    expect(text).not.toContain('Speaker 1');
  });

  it('does not take another meeting’s speaker of the same id', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([
      {
        meetingId: 'm1', meetingTitle: 'Standup', createdAt: 1, id: 'i1', content: STORED,
        ownerJson: OWNER_S1, source: 'rule', anchorStartMs: 5000,
      },
    ]);
    (db.speakerNames as jest.Mock).mockResolvedValue(new Map([[`m2\u0000s1`, 'Ravi']]));
    const text = everything(await draw(<ActionsScreen navigation={{ navigate: jest.fn() } as any} route={{} as any} />));
    expect(text).toContain('Speaker 1');
    expect(text).not.toContain('Ravi');
  });
});

describe('Threads', () => {
  const thread = {
    tag: 'ops',
    meetings: [{ id: 'm1', title: 'Ops weekly', createdAt: 3, template: null }],
    open: [
      {
        itemId: 'a1', meetingId: 'm1', meetingTitle: 'Ops weekly', meetingAt: 3, content: STORED,
        itemType: null, status: null, dateNorm: null, ownerJson: OWNER_S1, ownerName: 'Priya', anchorStartMs: 5000,
      },
      {
        itemId: 'a2', meetingId: 'm1', meetingTitle: 'Ops weekly', meetingAt: 3, content: 'Check with finance — Ravi',
        itemType: null, status: null, dateNorm: null, ownerJson: null, ownerName: null, anchorStartMs: 9000,
      },
    ],
    decisions: [],
  };

  it('shows the open action’s owner under the current name', async () => {
    (db.thread as jest.Mock).mockResolvedValue(thread);
    const tree = await draw(
      <ThreadScreen navigation={{ navigate: jest.fn(), goBack: jest.fn() } as any} route={{ params: { tag: 'ops' } } as any} />,
    );
    const text = everything(tree);
    expect(text).toContain('Priya');
    expect(text).not.toContain('Speaker 1');
    expect(text).toContain('Ravi');
  });
});

describe('Search', () => {
  const OPEN = String.fromCharCode(2);
  const CLOSE = String.fromCharCode(3);
  it('drops the extractor "— Unassigned" from an item row and keeps what was said as said', async () => {
    jest.useFakeTimers();
    (db.listMeetings as jest.Mock).mockResolvedValue([{ id: 'm1', title: 'Sync', createdAt: Date.now() }]);
    (db.listArchived as jest.Mock).mockResolvedValue([]);
    (db.allActions as jest.Mock).mockResolvedValue([]);
    (db.backfillEmbeddings as jest.Mock).mockResolvedValue(0);
    (db.search as jest.Mock).mockResolvedValue([
      { meetingId: 'm1', kind: 'item', refId: 'i1', startMs: 5000, snippet: `Send the ${OPEN}report${CLOSE} — Unassigned`, score: 1 },
      { meetingId: 'm1', kind: 'utterance', refId: 'u1', startMs: 6000, snippet: 'We are Unassigned for now — Unassigned', score: 1 },
    ]);
    const tree = await draw(
      <SearchScreen
        navigation={{ navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any}
        route={{} as any}
      />,
    );
    await act(async () => {
      tree.root.findByType(require('react-native').TextInput).props.onChangeText('report');
      jest.advanceTimersByTime(300);
    });
    await act(async () => {});
    const labels = tree.root
      .findAllByProps({ accessibilityRole: 'button' }, { deep: false })
      .map(n => n.props.accessibilityLabel as string)
      .filter(l => typeof l === 'string');
    expect(labels).toContain('item: Send the report');
    expect(labels.some(l => l.includes('Unassigned') && l.startsWith('item'))).toBe(false);
    expect(labels).toContain('said: We are Unassigned for now — Unassigned');
    jest.useRealTimers();
  });
});
