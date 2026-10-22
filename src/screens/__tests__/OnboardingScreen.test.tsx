import React from 'react';
import renderer, { act } from 'react-test-renderer';
import OnboardingScreen from '../OnboardingScreen';
import { Button } from '../../components/ui';
import ModelManager from '../../native/NativeModelManager';
import Licence from '../../native/NativeLicence';
import Storage from '../../native/NativeStorage';
import { SAMPLE_ID } from '../../sample/sampleId';
import { seedSample } from '../../sample/seedSample';
import { resetDownloadsForTest } from '../../setup/essentialDownload';
import { freeHeadline } from '../../billing/allowanceCopy';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../sample/seedSample', () => ({
  seedSample: jest.fn(async () => ({ created: true })),
  deleteSample: jest.fn(async () => {}),
}));

const MB = 1_000_000;
const row = (id: string, purpose: string, kind: string, mb: number, over: Record<string, unknown> = {}) => ({
  id, name: id, purpose, detail: '', kind, required: true, installed: false, needsSubscription: false,
  sizeBytes: mb * MB, heldBytes: 0, unsupportedReason: null, ...over,
});
/** First run as shipped: 114 MB required, plus the 1.1 GB Pro writer. */
const catalog = (over: { installed?: boolean } = {}) => [
  row('vad', 'Voice detection', 'vad', 2, over),
  row('asr', 'Speech to text', 'asr', 60, over),
  row('diar', 'Who spoke', 'diar', 52, over),
  row('llm', 'The writer', 'llm', 1100, { required: false, needsSubscription: true }),
];

const navigation = {
  navigate: jest.fn(),
  replace: jest.fn(),
  reset: jest.fn(),
  addListener: jest.fn(() => jest.fn()),
} as never;
const nav = navigation as any;
const route = { key: 'onboarding', name: 'Onboarding', params: undefined } as never;

function setNative(rows: unknown[], fit = { cpuReason: null as string | null, freeBytes: 10_000 * MB }) {
  (ModelManager.list as jest.Mock).mockResolvedValue(JSON.stringify(rows));
  (ModelManager as any).deviceFit = jest.fn(async () => JSON.stringify(fit));
}
const freePhone = () =>
  (Licence.status as jest.Mock).mockResolvedValue({ plan: 'free', state: 'none', paid: false, expiresAt: 0, account: null, lapsedCopy: '' });

async function show() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<OnboardingScreen navigation={navigation} route={route} />);
  });
  return tree;
}
const texts = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => String(n.type) === 'Text').map(n => [n.props.children].flat().join(''));
/** Press whatever carries this visible label (Button and SoftButton hold it in a Text child). */
async function pressLabel(t: renderer.ReactTestRenderer, label: string) {
  const text = t.root.find(n => String(n.type) === 'Text' && [n.props.children].flat().join('') === label);
  let node: renderer.ReactTestInstance | null = text;
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`nothing pressable around "${label}"`);
  await act(async () => {
    await node!.props.onPress();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetDownloadsForTest();
  setNative(catalog());
  freePhone();
  (ModelManager.download as jest.Mock).mockImplementation(async () => {});
  (Storage.query as jest.Mock).mockImplementation(async () => '[]');
});

describe('the first screen leads with value', () => {
  it('starts the essential download by itself and shows "Preparing your app", with no button to skip it', async () => {
    let release!: () => void;
    (ModelManager.download as jest.Mock).mockImplementation(() => new Promise<void>(r => { release = r; }));
    const tree = await show();
    expect(texts(tree)).toContain('Preparing your app');
    // 2 + 60 + 52 MB; the 1.1 GB writer is not in it.
    expect((ModelManager.download as jest.Mock).mock.calls.map(c => c[0])).toEqual(['vad']);
    expect(tree.root.findAllByType(Button)).toHaveLength(0);
    expect(texts(tree).some(x => /Later, from Settings|Continue without it/.test(x))).toBe(false);
    release();
    await act(async () => tree.unmount());
  });

  it('keeps the welcome readable while the download runs, with the progress beside it', async () => {
    let release!: () => void;
    (ModelManager.download as jest.Mock).mockImplementation(() => new Promise<void>(r => { release = r; }));
    const tree = await show();
    const t = texts(tree);
    expect(t).toContain('Your private meeting note-taker');
    expect(t).toContain('Private by design');
    expect(t).toContain('Preparing your app');
    expect(t).toContain('Voice detection');
    expect(t).toContain('1 of 3');
    expect(t.some(x => /It carries on if you leave the app/.test(x))).toBe(true);
    expect(t.some(x => /Keep the app open/.test(x))).toBe(false);
    release();
    await act(async () => tree.unmount());
  });

  it('asks no plan decision: no Start free, no trial button', async () => {
    const t = texts(await show());
    expect(t.some(x => /Start free|Try Pro free|Get Pro/.test(x))).toBe(false);
  });

  it('keeps an accessible Pro entry in the header that opens the existing Pro screen', async () => {
    setNative(catalog({ installed: true }));
    setNative(catalog({ installed: true }));
    const tree = await show();
    const pro = tree.root.findByProps({ accessibilityLabel: 'See Verbale Pro' });
    expect(pro.props.accessibilityRole).toBe('button');
    await act(async () => pro.props.onPress());
    expect(nav.navigate).toHaveBeenCalledWith('Paywall', { from: 'onboarding' });
    await act(async () => tree.unmount());
  });

  it('opens the sample with no download', async () => {
    setNative(catalog({ installed: true }));
    const tree = await show();
    await pressLabel(tree, 'See a sample meeting first');
    expect(seedSample).toHaveBeenCalledTimes(1);
    expect(nav.navigate).toHaveBeenCalledWith('Meeting', { meetingId: SAMPLE_ID });
    expect(ModelManager.download).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('says so, and still offers setup, when the sample cannot be opened', async () => {
    (seedSample as jest.Mock).mockRejectedValueOnce(new Error('disk'));
    setNative(catalog({ installed: true }));
    const tree = await show();
    await pressLabel(tree, 'See a sample meeting first');
    expect(nav.navigate).not.toHaveBeenCalledWith('Meeting', expect.anything());
    expect(texts(tree)).toContain('The sample could not be opened. Setting up still works.');
    await act(async () => tree.unmount());
  });

  it('hides advanced choices behind "More options", on a phone that can run the writer', async () => {
    setNative(catalog({ installed: true }));
    const tree = await show();
    expect(texts(tree).some(x => /Write the minutes in plain English/.test(x))).toBe(false);
    await act(async () => tree.root.findByProps({ accessibilityLabel: 'More options' }).props.onPress());
    expect(texts(tree).some(x => /Write the minutes in plain English/.test(x))).toBe(true);
    expect(tree.root.findByProps({ accessibilityLabel: 'Hide more options' }).props.accessibilityState).toEqual({ expanded: true });
    await act(async () => tree.unmount());
  });

  it('offers no "More options" on a phone that cannot run the writer and has no subscription', async () => {
    setNative(
      catalog().map(r => (r.id === 'llm' ? { ...r, unsupportedReason: 'Needs 4 GB.' } : r)),
    );
    const tree = await show();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'More options' })).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  it('keeps the total size and the free-space reason visible BEFORE downloading, in the shared wording', async () => {
    setNative(catalog(), { cpuReason: null, freeBytes: 50 * MB });
    const tree = await show();
    expect(texts(tree).some(x => /Downloading the speech models needs 219 MB free; this phone has 50 MB free/.test(x))).toBe(true);
    expect(tree.root.findAllByType(Button)).toHaveLength(0); // a button that would be refused is not offered
    await act(async () => tree.unmount());
  });

  it('says so, and offers nothing to download, on a phone the engines cannot run', async () => {
    setNative(catalog(), { cpuReason: 'This phone is too old.', freeBytes: 10_000 * MB });
    const tree = await show();
    expect(texts(tree)).toContain('Not this phone');
    expect(tree.root.findAllByType(Button)).toHaveLength(0);
    await act(async () => tree.unmount());
  });
});

describe('setup, and what comes after', () => {
  it('downloads only the essentials on its own, then offers "Start recording", which opens the recorder', async () => {
    const tree = await show();
    expect((ModelManager.download as jest.Mock).mock.calls.map(c => c[0])).toEqual(['vad', 'asr', 'diar']);
    expect(texts(tree)).toContain('All set');

    await pressLabel(tree, 'Start recording');
    expect(nav.reset).toHaveBeenCalledWith({ index: 1, routes: [{ name: 'Library' }, { name: 'Record' }] });
    expect(nav.replace).not.toHaveBeenCalled(); // not the Library
    await act(async () => tree.unmount());
  });

  it('explains English and the Free allowance before the first recording', async () => {
    const tree = await show();
    expect(texts(tree)).toContain(`Verbale works in English. ${freeHeadline}`);
    await act(async () => tree.unmount());
  });

  it('says only the language to a subscriber, who never sees allowance copy', async () => {
    (Licence.status as jest.Mock).mockResolvedValue({ plan: 'pro', state: 'active', paid: true, expiresAt: 0, account: null, lapsedCopy: '' });
    setNative(catalog({}).map(r => (r.id === 'llm' ? { ...r, unsupportedReason: 'Needs 4 GB.' } : r)));
    const tree = await show();
    expect(texts(tree)).toContain('Verbale works in English.');
    expect(texts(tree).some(x => x.includes(freeHeadline))).toBe(false);
    await act(async () => tree.unmount());
  });

  it('with everything already on the phone the primary action is "Start recording" at once', async () => {
    setNative(catalog({ installed: true }));
    const tree = await show();
    const primary = tree.root.findAllByType(Button);
    expect(primary).toHaveLength(1);
    expect(primary[0].props.label).toBe('Start recording');
    await pressLabel(tree, 'Start recording');
    expect(nav.reset).toHaveBeenCalledWith({ index: 1, routes: [{ name: 'Library' }, { name: 'Record' }] });
    expect(ModelManager.download).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('a failed essential download is never a dead end: retry resumes, or continue to the Library', async () => {
    (ModelManager.download as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const tree = await show();
    expect(texts(tree)).toContain('That download stopped');
    expect(texts(tree).some(x => x.includes('Voice detection'))).toBe(true);

    await pressLabel(tree, 'Try again');
    expect(texts(tree)).toContain('All set');
    await act(async () => tree.unmount());

    // And the other way out.
    resetDownloadsForTest();
    (ModelManager.download as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const tree2 = await show();
    await pressLabel(tree2, 'Continue without it');
    expect(nav.replace).toHaveBeenCalledWith('Library');
    await act(async () => tree2.unmount());
  });
});
