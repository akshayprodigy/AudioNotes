import React from 'react';
import { Alert, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import SharePreviewScreen from '../SharePreviewScreen';
import FileExport from '../../native/NativeFileExport';
import Player from '../../native/NativePlayer';
import { db } from '../../db/queries';
import { AUDIO_DELETED_MESSAGE, MP3_LABEL } from '../formats';

/**
 * Every file export is Pro, and the gate is NATIVE: the Share screen opens for everybody, shows the
 * preview, and turns a PRO_REQUIRED rejection into the Pro sheet. It never decides who is Pro.
 */
jest.mock('../../db/queries');
jest.mock('../../native/NativePlayer', () => ({
  __esModule: true,
  default: { hasAudio: jest.fn(async () => true) },
}));
jest.mock('../../native/NativeFileExport', () => ({
  __esModule: true,
  default: {
    preview: jest.fn(async () => '# Notes\n'),
    shareWith: jest.fn(async () => {}),
    exportMp3: jest.fn(async () => {}),
    cancelMp3: jest.fn(async () => {}),
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const nav = { navigate: jest.fn(), goBack: jest.fn() } as any;
const route = { key: 'k', name: 'Share', params: { meetingId: 'm1' } } as any;
const shareWith = FileExport.shareWith as jest.Mock;
const exportMp3 = FileExport.exportMp3 as jest.Mock;
const cancelMp3 = FileExport.cancelMp3 as jest.Mock;
const preview = FileExport.preview as jest.Mock;
const hasAudio = Player.hasAudio as jest.Mock;

const flat = (c: any): string =>
  Array.isArray(c) ? c.map(flat).join('') : typeof c === 'string' ? c : c?.props ? flat(c.props.children) : '';
const reject = (code: string, message = code) => Object.assign(new Error(message), { code });

const mounted: renderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const t of mounted.splice(0)) act(() => t.unmount());
});
beforeEach(() => {
  jest.clearAllMocks();
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  hasAudio.mockResolvedValue(true);
  preview.mockResolvedValue('# Notes\n');
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

async function open() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<SharePreviewScreen navigation={nav} route={route} />);
  });
  mounted.push(tree);
  return tree;
}
const texts = (t: renderer.ReactTestRenderer) => t.root.findAllByType(Text).map(n => flat(n.props.children));
const mp3Row = (t: renderer.ReactTestRenderer) => t.root.findAll(n => n.props.accessibilityLabel === MP3_LABEL && typeof n.props.onPress === 'function')[0];
// The header says "Share" too, but nothing presses it: take the text whose ancestor is a Pressable.
const pressable = (t: renderer.ReactTestRenderer, label: string) => {
  for (const txt of t.root.findAllByType(Text).filter(n => flat(n.props.children) === label)) {
    let p: any = txt.parent;
    while (p && typeof p.props.disabled !== 'boolean') p = p.parent;
    if (p) return p;
  }
  throw new Error(`no button labelled ${label}`);
};
const press = (t: renderer.ReactTestRenderer, label: string) =>
  act(async () => {
    // Not awaited: an export in progress is a promise that has not settled, and act must not wait on it.
    pressable(t, label).props.onPress();
    await Promise.resolve();
  });
const choose = (t: renderer.ReactTestRenderer) =>
  act(async () => {
    mp3Row(t).props.onPress();
  });

describe('a Free person on the Share screen', () => {
  it('sees the preview, and Share on a document opens the Pro sheet instead of an error', async () => {
    shareWith.mockRejectedValueOnce(reject('PRO_REQUIRED'));
    const tree = await open();
    expect(preview).toHaveBeenCalledWith('m1', 'pdf', false); // free to look
    await press(tree, 'Share');
    expect(nav.navigate).toHaveBeenCalledWith('Paywall', { meetingId: 'm1' });
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('is sent to the Pro sheet from the MP3 export too', async () => {
    exportMp3.mockRejectedValueOnce(reject('PRO_REQUIRED'));
    const tree = await open();
    await choose(tree);
    await press(tree, 'Share');
    expect(nav.navigate).toHaveBeenCalledWith('Paywall', { meetingId: 'm1' });
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('still gets an honest error for a failure that is not the gate', async () => {
    shareWith.mockRejectedValueOnce(reject('export_failed', 'disk full'));
    const tree = await open();
    await press(tree, 'Share');
    expect(Alert.alert).toHaveBeenCalledWith('Could not share', 'disk full');
    expect(nav.navigate).not.toHaveBeenCalled();
  });
});

describe('MP3 (original recording)', () => {
  it('is offered, and sharing it calls exportMp3 — not shareWith, not a preview', async () => {
    const tree = await open();
    expect(texts(tree)).toContain(MP3_LABEL);
    preview.mockClear();
    await choose(tree);
    expect(preview).not.toHaveBeenCalled();
    await press(tree, 'Share');
    expect(exportMp3).toHaveBeenCalledWith('m1');
    expect(shareWith).not.toHaveBeenCalled();
  });

  it('is disabled with the reason when the recording is gone, and never calls the encoder', async () => {
    hasAudio.mockResolvedValue(false);
    const tree = await open();
    expect(mp3Row(tree).props.disabled).toBe(true);
    expect(texts(tree)).toContain(AUDIO_DELETED_MESSAGE);
    // Even a stray tap on the dead row cannot start an encode: the Share button is dead with it.
    await act(async () => {
      mp3Row(tree).props.onPress?.();
    });
    expect(pressable(tree, 'Share').props.disabled).toBe(true);
    expect(exportMp3).not.toHaveBeenCalled();
  });

  it('turns AUDIO_DELETED from the native side into the same sentence and disables the row', async () => {
    exportMp3.mockRejectedValueOnce(reject('AUDIO_DELETED', AUDIO_DELETED_MESSAGE));
    const tree = await open();
    await choose(tree);
    await press(tree, 'Share');
    expect(texts(tree)).toContain(AUDIO_DELETED_MESSAGE);
    expect(mp3Row(tree).props.disabled).toBe(true);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('shows progress while it encodes, and Cancel stops it quietly', async () => {
    let finish!: (e?: any) => void;
    exportMp3.mockImplementationOnce(() => new Promise((_, rej) => (finish = rej)));
    const tree = await open();
    await choose(tree);
    await press(tree, 'Share');
    await act(async () => {
      (global as any).__TEST_EMIT__('onMp3Progress', { fraction: 0.42 });
    });
    expect(texts(tree).some(t => t.includes('42%'))).toBe(true);
    await press(tree, 'Cancel');
    expect(cancelMp3).toHaveBeenCalled();
    await act(async () => {
      finish(reject('cancelled'));
    });
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(texts(tree).some(t => t.includes('42%'))).toBe(false);
  });
});
