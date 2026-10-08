import React from 'react';
import { Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import SharePreviewScreen from '../SharePreviewScreen';
import FileExport from '../../native/NativeFileExport';
import { db } from '../../db/queries';
import { ATTRIBUTION_KEY } from '../attribution';
import { ATTRIBUTION } from '../markers';

jest.mock('../../db/queries');
jest.mock('../../native/NativeFileExport', () => ({
  __esModule: true,
  default: {
    preview: jest.fn(),
    shareWith: jest.fn(async () => {}),
    share: jest.fn(),
    render: jest.fn(),
    copy: jest.fn(),
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const nav = { navigate: jest.fn(), goBack: jest.fn() } as any;
const route = (meetingId = 'm1') => ({ key: 'share', name: 'Share', params: { meetingId } }) as any;

const MD =
  '# Design review\n\n_Thu 1 Jan 1970_\n\n## Action items\n\n' +
  '- [1:01] Book the room · Owner not set · No date given\n' +
  '- [1:10] Send the report — Priya (due Friday) · Done\n\n## Transcript\n\n**Priya:** Owner not set · Done\n';

const preview = FileExport.preview as jest.Mock;
const shareWith = FileExport.shareWith as jest.Mock;

const mounted: renderer.ReactTestRenderer[] = [];
afterEach(() => {
  // Unmount so the Switch's animation timers stop with the test that started them.
  for (const t of mounted.splice(0)) act(() => t.unmount());
});

async function open(meetingId = 'm1') {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<SharePreviewScreen navigation={nav} route={route(meetingId)} />);
  });
  mounted.push(tree);
  return tree;
}
const lineTexts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => n.type === Text && n.props.testID === 'share-preview-line').map(n => flat(n.props.children));
const flat = (c: any): string =>
  Array.isArray(c) ? c.map(flat).join('') : typeof c === 'string' ? c : c?.props ? flat(c.props.children) : '';
const flags = (tree: renderer.ReactTestRenderer, kind: string) =>
  tree.root.findAll(n => n.type === Text && n.props.testID === `share-flag-${kind}`);
const byLabel = (tree: renderer.ReactTestRenderer, label: string) => {
  const labelled = tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  if (labelled.length) return labelled;
  // A Button carries its words as a Text child: the pressable is the nearest ancestor with onPress.
  const out: any[] = [];
  for (const t of tree.root.findAllByType(Text).filter(n => flat(n.props.children) === label)) {
    // The Pressable inside Raised: `disabled` is a boolean on it and on nothing nearer the text.
    let p: any = t.parent;
    while (p && typeof p.props.disabled !== 'boolean') p = p.parent;
    // A disabled button is not pressable, whatever handler its owner passed down.
    if (p && !p.props.disabled && typeof p.props.onPress === 'function') out.push(p);
  }
  return out;
};
const press = async (tree: renderer.ReactTestRenderer, label: string) => {
  await act(async () => {
    byLabel(tree, label)[0].props.onPress();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  preview.mockImplementation(async (_id: string, _f: string, attribution: boolean) =>
    attribution ? MD + '\n---\n\n*' + ATTRIBUTION + '*\n' : MD,
  );
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  (db.setSetting as jest.Mock).mockResolvedValue(undefined);
});

describe('the preview is the document', () => {
  it('shows the native text, line for line, and nothing else', async () => {
    const tree = await open();
    expect(lineTexts(tree).join('\n')).toBe(MD);
  });

  it('asks for exactly the format it is about to share', async () => {
    const tree = await open();
    expect(preview).toHaveBeenLastCalledWith('m1', 'pdf', false);
    await press(tree, 'Markdown');
    expect(preview).toHaveBeenLastCalledWith('m1', 'md', false);
    await press(tree, 'Share');
    expect(shareWith).toHaveBeenCalledWith('m1', 'md', false);
  });

  it('every format stays on offer, free', async () => {
    const tree = await open();
    for (const f of ['PDF', 'Markdown', 'Text', 'Subtitles']) expect(byLabel(tree, f)).not.toHaveLength(0);
  });

  it('draws what was not settled apart from the sentence, and says what the colour means', async () => {
    const tree = await open();
    await press(tree, 'Markdown');
    expect(flags(tree, 'unresolved').map(n => flat(n.props.children))).toEqual(['Owner not set', 'No date given']);
    expect(flags(tree, 'done').map(n => flat(n.props.children))).toEqual(['Done']);
    const texts = tree.root.findAllByType(Text).map(n => flat(n.props.children));
    expect(texts.some(t => t.includes('did not settle') && t.includes('Nothing is filled in'))).toBe(true);
    // The two styles are visibly different from each other and from plain text.
    const style = (n: any) => JSON.stringify(n.props.style);
    expect(style(flags(tree, 'unresolved')[0])).not.toBe(style(flags(tree, 'done')[0]));
  });

  it('a transcript line that happens to say Done is not drawn as a flag', async () => {
    const tree = await open();
    expect(flags(tree, 'done')).toHaveLength(1);
  });

  it('the sample banner is screen chrome and is not in what is shared', async () => {
    const { sampleBannerText } = require('../../sample/sampleId');
    const tree = await open('sample-meeting-v1');
    expect(preview).toHaveBeenCalledWith('sample-meeting-v1', 'pdf', false);
    const all = tree.root.findAllByType(Text).map(n => flat(n.props.children)).join('\n');
    expect(all).not.toContain(sampleBannerText);
  });
});

describe('the attribution toggle', () => {
  it('is off until the person turns it on', async () => {
    const tree = await open();
    expect(preview).toHaveBeenLastCalledWith('m1', 'pdf', false);
    const sw = tree.root.findAll(n => n.props.accessibilityRole === 'switch')[0];
    expect(sw.props.accessibilityState.checked).toBe(false);
  });

  it('turns on, previews the line once at the end, remembers, and shares with it', async () => {
    const tree = await open();
    await press(tree, 'Markdown');
    await act(async () => {
      tree.root.findAll(n => n.props.accessibilityRole === 'switch')[0].props.onPress();
    });
    expect(db.setSetting).toHaveBeenCalledWith(ATTRIBUTION_KEY, '1');
    expect(preview).toHaveBeenLastCalledWith('m1', 'md', true);
    const lines = lineTexts(tree);
    expect(lines.filter(l => l.includes(ATTRIBUTION))).toHaveLength(1);
    expect(lines[lines.length - 1].includes(ATTRIBUTION) || lines[lines.length - 2].includes(ATTRIBUTION)).toBe(true);
    await press(tree, 'Share');
    expect(shareWith).toHaveBeenCalledWith('m1', 'md', true);
  });

  it('touching the words toggles it, as the switch does; on subtitles they do nothing', async () => {
    const tree = await open();
    await act(async () => {
      tree.root.findByProps({ testID: 'credit-label' }).props.onPress();
    });
    expect(db.setSetting).toHaveBeenCalledWith(ATTRIBUTION_KEY, '1');
    expect(preview).toHaveBeenLastCalledWith('m1', 'pdf', true);
    await press(tree, 'Subtitles');
    expect(tree.root.findByProps({ testID: 'credit-label' }).props.disabled).toBe(true);
  });

  it('starts on when the person left it on', async () => {
    (db.getSetting as jest.Mock).mockResolvedValue('1');
    await open();
    expect(db.getSetting).toHaveBeenCalledWith(ATTRIBUTION_KEY);
    expect(preview).toHaveBeenLastCalledWith('m1', 'pdf', true);
    expect(preview).not.toHaveBeenCalledWith('m1', 'pdf', false);
  });

  it('subtitles never carry it, whatever the toggle says', async () => {
    (db.getSetting as jest.Mock).mockResolvedValue('1');
    const tree = await open();
    await press(tree, 'Subtitles');
    expect(preview).toHaveBeenLastCalledWith('m1', 'srt', false);
    expect(tree.root.findAll(n => n.props.accessibilityRole === 'switch')).toHaveLength(0);
    await press(tree, 'Share');
    expect(shareWith).toHaveBeenCalledWith('m1', 'srt', false);
  });

  it('turning it off writes 0', async () => {
    (db.getSetting as jest.Mock).mockResolvedValue('1');
    const tree = await open();
    await act(async () => {
      tree.root.findAll(n => n.props.accessibilityRole === 'switch')[0].props.onPress();
    });
    expect(db.setSetting).toHaveBeenCalledWith(ATTRIBUTION_KEY, '0');
  });
});

describe('when the preview cannot be made', () => {
  it('says so and still lets the person share', async () => {
    preview.mockRejectedValue(new Error('boom'));
    const tree = await open();
    const all = tree.root.findAllByType(Text).map(n => flat(n.props.children)).join('\n');
    expect(all).toContain('could not be made');
    await press(tree, 'Share');
    expect(shareWith).toHaveBeenCalledWith('m1', 'pdf', false);
  });
});
