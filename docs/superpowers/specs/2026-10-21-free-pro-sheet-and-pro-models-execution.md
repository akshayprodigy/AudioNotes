# Execution sheet: the count opens Free-and-Pro; buying Pro downloads Pro's models at once

*Written 21 Oct 2026 by Opus for a Sonnet builder. Base: branch `pro-models-and-free-sheet` at
`e38c958` (the native half is already done there: `AsrChoice.kt`, so Pro now transcribes with
whisper-small once it is on the phone; and the download refusals no longer name the model). Anchors grepped the day of writing.*

**Why (founder, 21 Oct).** (1) The Pro pill clutters the Library header. Take it out. Tapping the
"3 of 5" count, which is where people already look when they think about the limit, opens a sheet
with Free beside Pro and a **Get Pro** button that opens the Pro screen. (2) Pro means better
models, not only more meetings. The moment Pro is bought, every Pro model this phone can run starts
downloading. The download runs **in the background**: the buyer is told they can leave the Pro
screen and use the app while it carries on. A Library card shows its progress, and on failure it
says why and offers Try again. A later launch picks up a download that stopped. **Nobody ever has
to go to Settings for it**, so on Pro, Settings has no Get or Remove button for Pro models, and
first-run setup has no switch for the writer. (3) No screen names a model ("Whisper small",
"Qwen3 4B"). Screens say only what a model is for. The open-source notices screen keeps the names,
because those are licence attributions.

## 1. Rules

TDD: each test first, watch it fail, then the code. Every named mutant must make a test fail; put
the code back after each one. One commit per step, with the message given. End every message with
`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push. Never run adb or the bare
gate: only `GATE_STAGES="types js scans" scripts/gate.sh`. Indent like the file (2 spaces).
`git status` must be clean when you stop. Hand over at 150 steps: commit, then write where you
stopped in the report.

## 2. Relevant files (read only these, only these lines)

| File | Lines | Why |
|---|---|---|
| `src/screens/LibraryScreen.tsx` | 15–22, 415–440, 698–752, 785–795, 905–935 | imports; `paid`/`paidKnown`; header + allowance line + summary strip; the "Pro pill is its door" comment; the sheets at the bottom |
| `src/screens/PaywallScreen.tsx` | 1–35, 155–345, 345–372, 480–500, 555–570, 600–630 | imports; state, effects, `fetchWriter`, `onBuy`, `onRestore`; `bought` + header Close; dock; the wifi note; styles |
| `src/screens/SettingsScreen.tsx` | 432–470, 496–590 | `onToggle`; the model row: Remove/Get button, meta line |
| `src/setup/essentialDownload.ts` | 1–130 | the first-run download store; Step 5 copies its shape |
| `src/setup/ReadinessCard.tsx` | 1–100 | the first-run card; Step 6 copies its look |
| `src/screens/__tests__/SettingsScreen.models.test.tsx` | 90–170 | the tests that read the model's name |
| `src/screens/OnboardingScreen.tsx` | 505–520 | the writer row's copy and Switch |
| `src/screens/PaywallScreen.tsx` (copy) | 143–150 | the larger-transcriber feature's body names the model |
| `src/screens/deviceFit.ts` | 1–30 | `runnable`, `sizeMb`, `writerBlockedReason` |
| `src/billing/allowanceCopy.ts` | 60–80 | `statusLine` |
| `src/screens/__tests__/LibraryScreen.test.tsx` | 1–80, 125–180, 380–455 | harness; header tests; allowance tests |
| `src/screens/__tests__/PaywallScreen.test.tsx` | 1–80, 100–125 | harness; the buy tests |
| `src/screens/__tests__/SettingsScreen.models.test.tsx` | 1–90 | harness |

## 3. Must not change

All native code (`android/`). `AllowanceNote.tsx`, `LibrarySummary.tsx`, `allowanceCopy.ts`,
`proHighlights.ts`, `trial.ts`, `subscription.ts`. `essentialDownload.ts`, `ReadinessCard.tsx`, `NoticesScreen.tsx` and `src/legal/`. Every gate other than the Library count:
the thread door, export, import and the exhausted card still open the Paywall directly. The
`PipelineController` / `process({ model: 'base' })` calls: native ignores that option now
(AsrChoice decides), so leave them alone.

## 4. Steps

### Step 1: `proToFetch`, the pure download plan

Create `src/billing/__tests__/proDownload.test.ts`:

```ts
import { proToFetch } from '../proDownload';

const row = (id: string, sizeBytes: number, o: Partial<{ installed: boolean; needsSubscription: boolean; unsupportedReason: string | null; kind: string }> = {}) => ({
  id, kind: 'asr', sizeBytes, installed: false, needsSubscription: true, unsupportedReason: null, ...o,
});

describe('proToFetch', () => {
  it('fetches every missing Pro model, smallest first, and nothing Free', () => {
    const plan = proToFetch([
      row('whisper-base', 59_707_625, { needsSubscription: false }),
      row('whisper-small', 190_085_487),
      row('llm-qwen', 1_100_000_000, { kind: 'llm' }),
      row('embed-bge-small', 36_000_000, { kind: 'llm' }),
    ]);
    expect(plan.map(m => m.id)).toEqual(['embed-bge-small', 'whisper-small', 'llm-qwen']);
  });

  it('skips what is installed and what this phone cannot run', () => {
    const plan = proToFetch([
      row('whisper-small', 190_085_487),
      row('llm-qwen', 1_100_000_000, { kind: 'llm', unsupportedReason: 'This phone has 3 GB of memory.' }),
      row('embed-bge-small', 36_000_000, { kind: 'llm', installed: true }),
    ]);
    expect(plan.map(m => m.id)).toEqual(['whisper-small']);
  });

  it('has nothing to fetch on a phone that already has them', () => {
    expect(proToFetch([row('whisper-small', 1, { installed: true })])).toEqual([]);
  });
});
```

Create `src/billing/proDownload.ts`:

```ts
import { runnable } from '../screens/deviceFit';

/** A ModelManager.list() row, as much of it as the plan reads. */
export type ProRow = {
  id: string;
  kind: string;
  sizeBytes: number;
  installed: boolean;
  needsSubscription: boolean;
  unsupportedReason?: string | null;
};

/**
 * What a subscription still has to put on THIS phone: every model the catalog puts behind Pro
 * (`needsSubscription`, decided natively in ModelCatalog), not yet installed, that this phone can
 * run. Smallest first, so the first improvement arrives in seconds rather than after the 1.1 GB
 * writer. Pure.
 */
export function proToFetch<T extends ProRow>(all: T[]): T[] {
  return runnable(all.filter(m => m.needsSubscription && !m.installed)).sort((a, b) => a.sizeBytes - b.sizeBytes);
}
```

Run `npx jest src/billing/__tests__/proDownload.test.ts` → 3 passed.
Mutants: (a) delete `.sort(...)` → test 1 fails; (b) delete `&& !m.installed` → test 2 fails.
Commit: `feat(billing): proToFetch - the Pro models this phone still needs, smallest first`.

### Step 2: `planCompare`, the pure Free-beside-Pro rows

Create `src/billing/__tests__/planCompare.test.ts`:

```ts
import { planCompare } from '../planCompare';

describe('planCompare', () => {
  it('on a phone that runs everything, lists every row', () => {
    const rows = planCompare(true, true);
    expect(rows.map(r => r.key)).toEqual(['meetings', 'length', 'transcript', 'minutes', 'search', 'export']);
    expect(rows.find(r => r.key === 'search')!.pro).toBe('By meaning, and Ask');
  });

  it('promises neither the transcriber nor the written minutes where the phone runs neither', () => {
    const rows = planCompare(false, false);
    expect(rows.map(r => r.key)).toEqual(['meetings', 'length', 'search', 'export']);
    expect(rows.find(r => r.key === 'search')!.pro).toBe('By meaning');
  });

  it("states Free's limits as the allowance does", () => {
    const rows = planCompare(false, false);
    expect(rows[0]).toEqual({ key: 'meetings', label: 'Meetings', free: '5 a month', pro: 'Unlimited' });
    expect(rows[1]).toEqual({ key: 'length', label: 'Length', free: 'Up to 1 hour', pro: 'Any length' });
  });
});
```

Create `src/billing/planCompare.ts`:

```ts
/**
 * Free beside Pro, for the sheet the Library's count opens. Every row is a claim the app keeps on
 * THIS phone: the transcriber row only where whisper-small runs, the written-minutes row and Ask
 * only where the writer runs. Pure.
 */
export type CompareRow = {
  key: 'meetings' | 'length' | 'transcript' | 'minutes' | 'search' | 'export';
  label: string;
  free: string;
  pro: string;
};

export function planCompare(writerRuns: boolean, smallRuns: boolean): CompareRow[] {
  const rows: CompareRow[] = [
    { key: 'meetings', label: 'Meetings', free: '5 a month', pro: 'Unlimited' },
    { key: 'length', label: 'Length', free: 'Up to 1 hour', pro: 'Any length' },
  ];
  if (smallRuns) rows.push({ key: 'transcript', label: 'Transcript', free: 'Standard', pro: 'More accurate' });
  if (writerRuns) rows.push({ key: 'minutes', label: 'Minutes', free: 'Pulled out by rule', pro: 'Written in sentences' });
  rows.push({ key: 'search', label: 'Search', free: 'By keyword', pro: writerRuns ? 'By meaning, and Ask' : 'By meaning' });
  rows.push({ key: 'export', label: 'Export', free: 'Copy the notes', pro: 'PDF, MP3, SRT and more' });
  return rows;
}
```

Run `npx jest src/billing/__tests__/planCompare.test.ts` → 3 passed.
Mutant: `if (smallRuns)` → `if (true)` → test 2 fails.
Commit: `feat(billing): planCompare - Free beside Pro, only what this phone runs`.

### Step 3: `ProCompareSheet`

Create `src/screens/ProCompareSheet.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ModelManager from '../native/NativeModelManager';
import { Button, SoftButton, Txt } from '../components/ui';
import { planCompare } from '../billing/planCompare';
import { statusLine } from '../billing/allowanceCopy';
import type { AllowanceStatus } from '../native/NativeLicence';
import { runnable } from './deviceFit';
import { radius, s, useTheme } from '../theme';

/**
 * What the Library's count opens on a Free phone: Free beside Pro, and one way on to buy it.
 *
 * It replaces the header's Pro pill (founder, 21 Oct: the pill cluttered the header, and the count
 * is where somebody already looks when they wonder about the limit). It reads the catalog each
 * time it opens, so it promises only what this phone runs.
 */
export default function ProCompareSheet({
  visible,
  allowance,
  onClose,
  onGetPro,
}: {
  visible: boolean;
  allowance: AllowanceStatus | null;
  onClose: () => void;
  onGetPro: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [runs, setRuns] = useState({ writer: false, small: false });

  useEffect(() => {
    if (!visible) return;
    ModelManager.list()
      .then(r => {
        const here = runnable<{ id: string; kind: string; unsupportedReason?: string | null }>(JSON.parse(r));
        setRuns({
          writer: here.some(m => m.id === 'llm-qwen'),
          small: here.some(m => m.id === 'whisper-small'),
        });
      })
      .catch(() => {});
  }, [visible]);

  const line = statusLine(allowance);
  const rows = planCompare(runs.writer, runs.small);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={st.fill} onPress={onClose} accessibilityLabel="Dismiss">
        <View style={[st.fill, st.scrim, { backgroundColor: colors.scrim }]} />
      </Pressable>
      <View
        testID="pro-compare"
        style={[st.card, { backgroundColor: colors.card, paddingBottom: insets.bottom + s(16) }]}>
        <View style={[st.grip, { backgroundColor: colors.line }]} />
        <Txt variant="sectionTitle">Free and Pro</Txt>
        {line ? (
          <Txt variant="chip" color={colors.inkDim} style={st.status}>
            {line}
          </Txt>
        ) : null}
        <View style={[st.row, st.headRow]}>
          <View style={st.label} />
          <Txt variant="overlineSm" color={colors.inkFaint} style={st.col}>
            FREE
          </Txt>
          <Txt variant="overlineSm" color={colors.primaryDeep} style={st.col}>
            PRO
          </Txt>
        </View>
        {rows.map(r => (
          <View
            key={r.key}
            testID={`compare-${r.key}`}
            accessible
            accessibilityLabel={`${r.label}: Free, ${r.free}. Pro, ${r.pro}.`}
            style={[st.row, { borderTopColor: colors.line }]}>
            <Txt variant="chip" color={colors.inkSoft} style={st.label}>
              {r.label}
            </Txt>
            <Txt variant="chip" color={colors.ink} style={st.col}>
              {r.free}
            </Txt>
            <Txt variant="chip" color={colors.primaryDeep} style={st.col}>
              {r.pro}
            </Txt>
          </View>
        ))}
        <View style={st.actions}>
          <Button label="Get Pro" icon="ai" onPress={onGetPro} full />
          <SoftButton label="Not now" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { opacity: 0.38 },
  card: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: s(20),
    paddingTop: s(10),
  },
  grip: { alignSelf: 'center', width: s(42), height: s(5), borderRadius: 999, marginBottom: s(14) },
  status: { marginTop: s(4) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(8),
    paddingVertical: s(9),
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  headRow: { marginTop: s(14), borderTopWidth: 0 },
  label: { flex: 1.1 },
  col: { flex: 1 },
  actions: { marginTop: s(16), gap: s(8) },
});
```

Create `src/screens/__tests__/ProCompareSheet.test.tsx`:

```tsx
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ProCompareSheet from '../ProCompareSheet';
import ModelManager from '../../native/NativeModelManager';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const list = ModelManager.list as unknown as jest.Mock;
afterEach(() => list.mockResolvedValue('[]'));

async function open(onGetPro = jest.fn()) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ProCompareSheet visible allowance={null} onClose={jest.fn()} onGetPro={onGetPro} />);
  });
  return tree;
}
const keys = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => typeof n.props.testID === 'string' && n.props.testID.startsWith('compare-'), { deep: false }).map(n => n.props.testID);

test('promises the larger transcriber where it runs, and the written minutes only where the writer runs', async () => {
  list.mockResolvedValue(JSON.stringify([
    { id: 'whisper-small', kind: 'asr', unsupportedReason: null },
    { id: 'llm-qwen', kind: 'llm', unsupportedReason: 'This phone has 3 GB of memory.' },
  ]));
  const tree = await open();
  expect(keys(tree)).toEqual(['compare-meetings', 'compare-length', 'compare-transcript', 'compare-search', 'compare-export']);
  await act(async () => tree.unmount());
});

test('Get Pro is the way on', async () => {
  const onGetPro = jest.fn();
  const tree = await open(onGetPro);
  await act(async () => tree.root.findAll(n => n.props.label === 'Get Pro' && typeof n.props.onPress === 'function')[0].props.onPress());
  expect(onGetPro).toHaveBeenCalled();
  await act(async () => tree.unmount());
});
```

Run `npx jest src/screens/__tests__/ProCompareSheet.test.tsx` → 2 passed.
Mutant: `writer: here.some(m => m.id === 'llm-qwen')` → `writer: true` → test 1 fails.
Commit: `feat(library): ProCompareSheet - Free beside Pro, and Get Pro`.

### Step 4: the Library: no pill, the count opens the sheet

**Tests first** in `src/screens/__tests__/LibraryScreen.test.tsx`:

(a) Replace the whole test `'on free the header has a "Get Pro" pill in place of Actions, and it opens the paywall'` (line 131) with:

```tsx
  test('on free the header carries neither a Pro pill nor Actions: the count is the way to Pro', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await focusTheLibrary();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Actions' }, { deep: false })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Get Pro' }, { deep: false })).toHaveLength(0);
    await act(async () => tree.unmount());
  });
```

(b) In `'buying Pro on the Pro screen is noticed when the library is focused again'` (line 164),
replace its first assertion line,
`expect(tree.root.findAllByProps({ accessibilityLabel: 'Get Pro' }, { deep: false })).toHaveLength(1);`,
with
`expect(tree.root.findAllByProps({ accessibilityLabel: 'Actions' }, { deep: false })).toHaveLength(0);`.
Leave the rest of that test as it is.

(c) Replace the two tests `'with nothing recorded, the allowance line opens the Pro screen'` and
`'with meetings saved, the summary strip opens the Pro screen on Free'` (lines 434–452) with:

```tsx
  const proSheet = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(n => n.props.testID === 'pro-compare', { deep: false });

  test('with nothing recorded, the count opens Free-and-Pro, and Get Pro there opens the Pro screen', async () => {
    const tree = await focusTheLibrary();
    expect(proSheet(tree)).toHaveLength(0);
    const [line] = tree.root.findAllByProps(
      { accessibilityLabel: '3 of 5 free meetings left · resets 1 November. Go unlimited with Pro.' },
      { deep: false },
    );
    await act(async () => line.props.onPress());
    expect((nav as any).navigate).not.toHaveBeenCalledWith('Paywall');
    expect(proSheet(tree)).toHaveLength(1);
    expect(texts(tree)).toEqual(expect.arrayContaining(['FREE', 'PRO', 'Meetings', '5 a month', 'Unlimited']));
    await act(async () =>
      tree.root.findAll(n => n.props.label === 'Get Pro' && typeof n.props.onPress === 'function')[0].props.onPress(),
    );
    expect((nav as any).navigate).toHaveBeenCalledWith('Paywall');
    expect(proSheet(tree)).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  test('with meetings saved, the summary strip opens Free-and-Pro on Free', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([saved]);
    const tree = await focusTheLibrary();
    const strip = tree.root.findAll(n => n.props.testID === 'library-summary', { deep: false })[0];
    await act(async () => strip.props.onPress());
    expect((nav as any).navigate).not.toHaveBeenCalledWith('Paywall');
    expect(proSheet(tree)).toHaveLength(1);
    await act(async () => tree.unmount());
  });
```

Run `npx jest src/screens/__tests__/LibraryScreen.test.tsx`: the new tests fail.

**Code** in `src/screens/LibraryScreen.tsx`:

1. Replace `import ProPill from './ProPill';` with `import ProCompareSheet from './ProCompareSheet';`.
2. Right after the line `const [paidKnown, setPaidKnown] = useState(false);` add:
   ```tsx
     // The Free-and-Pro sheet the count opens. Free only: Pro has no count.
     const [proSheet, setProSheet] = useState(false);
   ```
3. In the header, replace the whole `{paidKnown ? ( paid ? ( <IconButton … Actions … /> ) : ( <ProPill … /> ) ) : null}` block with:
   ```tsx
               {paidKnown && paid ? (
                 <IconButton icon="list" label="Actions" onPress={() => navigation.navigate('Actions')} />
               ) : null}
   ```
4. `<AllowanceLine status={allowance} onPress={() => navigation.navigate('Paywall')} />` →
   `<AllowanceLine status={allowance} onPress={() => setProSheet(true)} />`.
5. In `<LibrarySummary …>`, `onUpgrade={() => navigation.navigate('Paywall')}` → `onUpgrade={() => setProSheet(true)}`.
   (Only this one. The `onUpgrade` on `AddToProjectSheet` at ~line 931 stays.)
6. Right after the closing `/>` of `<AddToProjectSheet … />` add:
   ```tsx

         <ProCompareSheet
           visible={proSheet}
           allowance={allowance}
           onClose={() => setProSheet(false)}
           onGetPro={() => {
             setProSheet(false);
             navigation.navigate('Paywall');
           }}
         />
   ```
7. Comments: in the one near line 419 ("the header draws neither the pill nor Actions"), change it
   to say the header draws no Actions. In the one near line 790, change "(the Pro pill in the
   header is its door)" to "(the count's Free-and-Pro sheet is its door)".
8. `git rm src/screens/ProPill.tsx`.

Run `npx jest src/screens/__tests__/LibraryScreen.test.tsx` → all pass. Run `npx tsc --noEmit` → no errors.
Mutant: in step 4, put `navigation.navigate('Paywall')` back as the AllowanceLine's onPress → the first test in (c) fails.
Commit: `feat(library): the count opens Free-and-Pro; the Pro pill is gone`.


### Step 5: `proModels`, Pro's download as one background run the whole app can see

Create `src/setup/__tests__/proModels.test.ts`:

```ts
import ModelManager from '../../native/NativeModelManager';
import AudioPipeline from '../../native/NativeAudioPipeline';
import { autoStartProModels, resetProModelsForTest, runProModels, useProModelsStore } from '../proModels';
import { resetDownloadsForTest, useDownloadStore } from '../essentialDownload';

const list = ModelManager.list as jest.Mock;
const download = ModelManager.download as jest.Mock;
const rows = [
  { id: 'whisper-base', kind: 'asr', sizeBytes: 59_707_625, installed: true, needsSubscription: false, unsupportedReason: null },
  { id: 'whisper-small', kind: 'asr', sizeBytes: 190_085_487, installed: false, needsSubscription: true, unsupportedReason: null },
  { id: 'llm-qwen', kind: 'llm', sizeBytes: 1_100_000_000, installed: false, needsSubscription: true, unsupportedReason: null },
  { id: 'embed-bge-small', kind: 'llm', sizeBytes: 36_000_000, installed: false, needsSubscription: true, unsupportedReason: null },
];
const tick = () => new Promise(r => setImmediate(r));
const emit = (downloaded: number, total: number) =>
  (global as any).__TEST_EMIT__('onModelProgress', { id: 'x', downloaded, total });

beforeEach(() => {
  jest.clearAllMocks();
  resetProModelsForTest();
  resetDownloadsForTest();
  list.mockResolvedValue(JSON.stringify(rows));
  download.mockImplementation(async () => {});
});
afterEach(() => list.mockResolvedValue('[]'));

describe("Pro's background download", () => {
  it('fetches every Pro model this phone needs, smallest first, and settles clean', async () => {
    await expect(runProModels()).resolves.toBe(true);
    expect(download.mock.calls.map(c => c[0])).toEqual(['embed-bge-small', 'whisper-small', 'llm-qwen']);
    expect(useProModelsStore.getState()).toMatchObject({ running: false, error: null });
  });

  it('reports the whole run: the models finished plus the one in flight', async () => {
    const release: Array<() => void> = [];
    download.mockImplementation(() => new Promise<void>(r => release.push(r)));
    const done = runProModels();
    await tick();
    expect(useProModelsStore.getState()).toMatchObject({ running: true, total: 1_326_085_487, downloaded: 0 });
    emit(1000, 36_000_000);
    expect(useProModelsStore.getState().downloaded).toBe(1000);
    release[0]();
    await tick();
    expect(useProModelsStore.getState().downloaded).toBe(36_000_000);
    emit(500, 190_085_487);
    expect(useProModelsStore.getState().downloaded).toBe(36_000_500);
    release[1]();
    await tick();
    release[2]();
    await expect(done).resolves.toBe(true);
  });

  it("keeps a failure with native's reason, and a retry clears it the moment it starts", async () => {
    download.mockRejectedValueOnce(new Error('No connection'));
    await expect(runProModels()).resolves.toBe(false);
    expect(useProModelsStore.getState()).toMatchObject({ running: false, error: 'No connection' });
    const retry = runProModels();
    expect(useProModelsStore.getState().error).toBeNull();
    await expect(retry).resolves.toBe(true);
  });

  it("never runs beside first-run setup's download", async () => {
    useDownloadStore.setState({ running: true });
    await expect(runProModels()).resolves.toBe(false);
    expect(download).not.toHaveBeenCalled();
  });

  it('starts by itself only on Pro, and once per launch', async () => {
    expect(autoStartProModels(false)).toBeNull();
    await autoStartProModels(true);
    expect(autoStartProModels(true)).toBeNull();
    expect(download).toHaveBeenCalledTimes(3);
  });

  it('asks for the battery exemption only when there is something to fetch', async () => {
    list.mockResolvedValue(JSON.stringify(rows.map(r => ({ ...r, installed: true }))));
    await runProModels();
    expect(AudioPipeline.requestBatteryExemption).not.toHaveBeenCalled();
  });
});
```

Create `src/setup/proModels.ts`:

```ts
import { NativeEventEmitter, NativeModules } from 'react-native';
import { create } from 'zustand';
import ModelManager from '../native/NativeModelManager';
import AudioPipeline from '../native/NativeAudioPipeline';
import { proToFetch } from '../billing/proDownload';
import { useDownloadStore } from './essentialDownload';

/**
 * Pro's models as ONE background download the whole app can see (founder, 21 Oct). It starts the
 * moment Pro is bought, keeps going while the person leaves the Pro screen and uses the app, and a
 * later launch picks up a run that stopped. Nobody has to visit Settings for it. A sibling of
 * essentialDownload, with the same shape on purpose: native resumes a `.part`, so "Try again" and
 * "carry on" are the same call.
 */
type State = {
  running: boolean;
  /** Why the last run stopped, in native's words; null when it did not fail. */
  error: string | null;
  /** Bytes of the whole run: the models finished plus the one in flight. */
  downloaded: number;
  total: number;
};

const IDLE: State = { running: false, error: null, downloaded: 0, total: 0 };

export const useProModelsStore = create<State>(() => IDLE);

let inFlight: Promise<boolean> | null = null;
let doneBytes = 0;
let listening = false;
let autoTried = false;

function listen() {
  if (listening) return;
  listening = true;
  new NativeEventEmitter(NativeModules.ModelManager).addListener(
    'onModelProgress',
    (e: { total: number; downloaded: number }) => {
      const st = useProModelsStore.getState();
      if (!(e.total > 0) || !st.running) return;
      useProModelsStore.setState({ downloaded: Math.min(st.total, doneBytes + e.downloaded) });
    },
  );
}

/** Test seam: forget everything, including a run that never settled. */
export function resetProModelsForTest() {
  inFlight = null;
  doneBytes = 0;
  autoTried = false;
  useProModelsStore.setState(IDLE);
}

/**
 * Fetch every Pro model this phone still needs, smallest first. Resolves true once all are here.
 * A second call while one runs joins it. It never runs beside first-run setup's download, because
 * two downloads of the same model would write the same `.part` file.
 */
export function runProModels(): Promise<boolean> {
  if (inFlight) return inFlight;
  if (useDownloadStore.getState().running) return Promise.resolve(false);
  listen();
  useProModelsStore.setState({ ...IDLE, running: true });

  inFlight = (async () => {
    try {
      const todo = proToFetch(JSON.parse(await ModelManager.list()));
      const total = todo.reduce((a, m) => a + m.sizeBytes, 0);
      doneBytes = 0;
      useProModelsStore.setState({ total, downloaded: 0 });
      // The exemption is what lets 1.3 GB survive the screen going off. Asked only when there is
      // something to fetch: a Pro phone with everything on it must not see the system dialog.
      if (todo.length > 0) AudioPipeline.requestBatteryExemption().catch(() => {});
      for (const m of todo) {
        await ModelManager.download(m.id);
        doneBytes += m.sizeBytes;
        useProModelsStore.setState({ downloaded: doneBytes });
      }
      useProModelsStore.setState(IDLE);
      return true;
    } catch (e: any) {
      useProModelsStore.setState({ running: false, error: String(e?.message ?? e) });
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * On a Pro phone, without being asked, once per app process: picks up a run that stopped (the app
 * was closed, the phone lost signal). Not while setup's own download runs; then the next launch
 * tries, because `autoTried` is set only when a run actually starts.
 */
export function autoStartProModels(paid: boolean): Promise<boolean> | null {
  if (!paid || autoTried || inFlight || useDownloadStore.getState().running) return null;
  autoTried = true;
  return runProModels();
}
```

Run `npx jest src/setup/__tests__/proModels.test.ts` → 6 passed.
Mutants: (a) delete the `if (useDownloadStore.getState().running) return Promise.resolve(false);` line → "never runs beside" fails;
(b) `doneBytes + e.downloaded` → `e.downloaded` → "reports the whole run" fails;
(c) delete `autoTried = true;` → "once per launch" fails.
Commit: `feat(setup): proModels - Pro's download as one background run`.

### Step 6: the Library starts it by itself on Pro and shows it in a card

Create `src/setup/ProModelsCard.tsx`:

```tsx
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Icon from '../components/Icon';
import { ProgressBar, Raised, Txt } from '../components/ui';
import { downloadLabel, downloadPct } from '../screens/downloadLabel';
import { radius, s, useTheme } from '../theme';
import { runProModels, useProModelsStore } from './proModels';

/**
 * Pro's background download, on the Library: how far it has got and that it carries on while the
 * app is in use, or, when it stopped, why, with Try again. This is the way back from a failed
 * download, so nobody needs Settings for it. Nothing at all is drawn otherwise.
 */
export default function ProModelsCard() {
  const { colors } = useTheme();
  const { running, error, downloaded, total } = useProModelsStore();
  if (!error && !(running && total > 0)) return null;
  const tone = error ? colors.warning : colors.primary;

  return (
    <View style={st.wrap} testID="pro-models-card">
      <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
        <View style={st.body}>
          <View style={st.head}>
            <Icon name={error ? 'alert' : 'download'} size={s(20)} color={tone} strokeWidth={2.4} />
            <Txt variant="bodyStrong" style={st.flex}>
              {error ? "Pro's models did not finish downloading" : "Downloading Pro's models"}
            </Txt>
          </View>
          {error ? (
            <>
              <Txt variant="chip" color={colors.warning}>
                {error}
              </Txt>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Try again"
                onPress={() => {
                  runProModels().catch(() => {});
                }}
                style={st.action}>
                <Txt variant="cta" color={colors.primary}>
                  Try again
                </Txt>
              </Pressable>
            </>
          ) : (
            <>
              <ProgressBar pct={downloadPct(downloaded, total)} color={tone} track={colors.cardAlt} />
              <Txt variant="chip" color={colors.inkFaint}>
                {`${downloadLabel(downloaded, total)} · it carries on while you use the app.`}
              </Txt>
            </>
          )}
        </View>
      </Raised>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { marginHorizontal: s(20), marginTop: s(12) },
  body: { padding: s(14), gap: s(10) },
  head: { flexDirection: 'row', alignItems: 'center', gap: s(10) },
  flex: { flex: 1 },
  action: { minHeight: s(44), justifyContent: 'center', alignSelf: 'flex-start' },
});
```

**Tests first.** In `src/screens/__tests__/LibraryScreen.test.tsx` add these imports:
`import { resetProModelsForTest, useProModelsStore } from '../../setup/proModels';` and
`import ModelManager from '../../native/NativeModelManager';`. In the top-level `beforeEach`, add
`resetProModelsForTest();`. Append at the end of the file:

```tsx
describe("Pro's models download by themselves", () => {
  const download = ModelManager.download as unknown as jest.Mock;
  const list = ModelManager.list as unknown as jest.Mock;
  afterEach(() => list.mockResolvedValue('[]'));

  test('on Pro the library starts the download without being asked', async () => {
    list.mockResolvedValue(JSON.stringify([
      { id: 'whisper-small', kind: 'asr', sizeBytes: 190_085_487, installed: false, needsSubscription: true, unsupportedReason: null },
    ]));
    const tree = await focusTheLibrary();
    await act(async () => {});
    expect(download).toHaveBeenCalledWith('whisper-small');
    await act(async () => tree.unmount());
  });

  test('on Free it does not', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await focusTheLibrary();
    await act(async () => {});
    expect(download).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  test('a download that stopped shows why, with Try again, on the library itself', async () => {
    // Free, so the automatic start cannot settle after the error is set and overwrite it.
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await focusTheLibrary();
    await act(async () => {
      useProModelsStore.setState({ running: false, error: 'No connection', downloaded: 0, total: 0 });
    });
    const card = tree.root.findAll(n => n.props.testID === 'pro-models-card', { deep: false });
    expect(card).toHaveLength(1);
    expect(texts(tree)).toEqual(expect.arrayContaining(["Pro's models did not finish downloading", 'No connection', 'Try again']));
    await act(async () => tree.unmount());
  });
});
```

(`texts` is defined inside `describe('the Free allowance')`. If it is not in scope here, copy the
same one-line helper to the top of this describe.)

**Code** in `src/screens/LibraryScreen.tsx`:

1. Imports: `import ProModelsCard from '../setup/ProModelsCard';` and
   `import { autoStartProModels } from '../setup/proModels';`.
2. Right after the `proSheet` state from Step 4, add:
   ```tsx
     // Pro's models are part of Pro: on a Pro phone a download that stopped is picked up by itself,
     // once per launch, so nobody needs Settings for it.
     useEffect(() => {
       if (paidKnown) autoStartProModels(paid);
     }, [paid, paidKnown]);
   ```
3. Right after `<ReadinessCard setup={setup} />` add `<ProModelsCard />`.

Run `npx jest src/screens/__tests__/LibraryScreen.test.tsx` → all pass.
Mutant: `autoStartProModels(paid)` → `autoStartProModels(true)` → "on Free it does not" fails.
Commit: `feat(library): Pro's models download by themselves, with a card that says how far`.

### Step 7: the Paywall starts the download and lets the buyer go

**Tests first** in `src/screens/__tests__/PaywallScreen.test.tsx`:

1. Under the other `jest.mock` calls add:
   ```tsx
   jest.mock('../../setup/proModels', () => {
     const { create } = jest.requireActual('zustand');
     return {
       __esModule: true,
       useProModelsStore: create(() => ({ running: false, error: null, downloaded: 0, total: 0 })),
       runProModels: jest.fn(() => Promise.resolve(true)),
     };
   });
   ```
   and the import `import { runProModels, useProModelsStore } from '../../setup/proModels';`.
2. Append at the END of the file:

```tsx
describe("after buying, Pro's models download in the background", () => {
  const idle = { running: false, error: null, downloaded: 0, total: 0 };
  afterEach(() => useProModelsStore.setState(idle));
  const closes = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(n => n.props.label === 'Close' && typeof n.props.onPress === 'function');

  async function buy(params?: { from?: 'onboarding' | 'export' }) {
    sellsPlans([monthlyTrial, annualTrial]);
    (buyWithPlay as jest.Mock).mockResolvedValue({ paid: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render(params);
    (entitlement as jest.Mock).mockResolvedValue({ paid: true, licence: { paid: true } });
    await act(async () => {
      tree.root.findByProps({ label: 'Try it free for 7 days' }).props.onPress();
    });
    await act(async () => {});
    return { tree, alert };
  }

  it('buying starts the download at once, and says it carries on in the background', async () => {
    const { tree, alert } = await buy();
    expect(runProModels).toHaveBeenCalled();
    expect(alert.mock.calls[0][1]).toContain('carries on in the background');
    await act(async () => tree.unmount());
  });

  it('the buyer can leave while it downloads, and is told so', async () => {
    const { tree } = await buy();
    await act(async () => {
      useProModelsStore.setState({ running: true, error: null, downloaded: 1, total: 100 });
    });
    expect(closes(tree).length).toBeGreaterThan(0);
    expect(texts(tree)).toContain('You can leave this screen. The download carries on in the background while you use the app.');
    await act(async () => tree.unmount());
  });

  it('a failed download says why and offers Try again', async () => {
    const { tree } = await buy();
    (runProModels as jest.Mock).mockClear();
    await act(async () => {
      useProModelsStore.setState({ running: false, error: 'No connection', downloaded: 0, total: 0 });
    });
    expect(texts(tree)).toContain("Pro's models did not finish downloading: No connection");
    await act(async () => {
      tree.root.findAll(n => n.props.label === 'Try again' && typeof n.props.onPress === 'function')[0].props.onPress();
    });
    expect(runProModels).toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('opened on Pro, the screen picks up a download that stopped', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true, licence: { paid: true } });
    const tree = await render();
    expect(runProModels).toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('from first run, a purchase leaves the download to setup', async () => {
    const { tree } = await buy({ from: 'onboarding' });
    expect(nav.goBack).toHaveBeenCalled();
    expect(runProModels).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });
});
```

Run `npx jest src/screens/__tests__/PaywallScreen.test.tsx`: the new tests fail.

**Code** in `src/screens/PaywallScreen.tsx`:

1. Imports: add `import { proToFetch } from '../billing/proDownload';` and
   `import { runProModels, useProModelsStore } from '../setup/proModels';`. In the `./deviceFit`
   import keep only what is still used (`runnable` goes; tsc/eslint will name anything else).
2. Delete the `writerMb` and `writerInstalled` state (lines 175–179, with their comment) and the
   `dl` state (lines 183–186, with its comment). In their place add:
   ```tsx
     // What buying would fetch on THIS phone, quoted under the button.
     const [proMb, setProMb] = useState(0);
     // Pro's background download (src/setup/proModels): its progress and why it stopped.
     const pro = useProModelsStore();
   ```
3. In the `ModelManager.list()` effect, add `needsSubscription: boolean;` to the row type of
   `all`. Replace everything from `const writer = runnable(...)` to the end of the
   `if (pendingBytes > 0) { … }` block with the following (the original `setWriterBlocked` line
   goes inside it, once):
   ```tsx
           setWriterBlocked(writerBlockedReason(all));
           const todo = proToFetch(all);
           setProMb(sizeMb(todo));
           const pendingBytes = todo.reduce((a, m) => a + m.sizeBytes, 0);
           if (pendingBytes > 0) {
             ModelManager.deviceFit()
               .then(r => {
                 const fit: { freeBytes: number } = JSON.parse(r);
                 setSpaceShort(spaceFits(pendingBytes, fit.freeBytes) ? null : spaceReason("Pro's models", pendingBytes, fit.freeBytes));
               })
               .catch(() => {});
           }
   ```
4. Delete the whole `onModelProgress` listener effect (lines 249–255) and the whole
   `fetchWriter` (its doc comment and its `useCallback`, lines 257–286). The store owns both now.
5. In `onBuy`: delete the line `await fetchWriter();`, change the deps array to
   `[chosenPlan, plans, load, navigation, route.params]`, and change the Alert's two bodies to:
   ```tsx
          free
            ? `Pro is on, free for ${free}. Cancel in Google Play before then and you pay nothing. ` +
              "Pro's models are downloading now. The download carries on in the background while you use the app."
            : "Pro's models are downloading now. The download carries on in the background while you use the app.",
   ```
6. Right after the line `const bought = Boolean(ent?.licence?.paid);` add:
   ```tsx

     // Bought: start Pro's download at once, straight after a purchase, a restore or a sign-in, and
     // pick up one that stopped whenever this screen opens on Pro. runProModels does nothing when
     // everything is already here, and joins a run already going. First run is the exception:
     // setup's own download fetches Pro's models there, and two runs would race.
     useEffect(() => {
       if (bought && route.params?.from !== 'onboarding') runProModels().catch(() => {});
     }, [bought, route.params]);
   ```
7. `SignInForm`'s `onSignedIn={res => { if (res.paid) navigation.goBack(); }}` →
   `onSignedIn={res => { if (res.paid) load(); }}`, so a web subscriber who signs in here gets
   the models the way a buyer does.
8. The dock: replace the `{dl !== null ? ( … ) : null}` block with:
   ```tsx
           {pro.running && pro.total > 0 ? (
             <View style={st.dl}>
               <Txt variant="chip" color={colors.inkSoft}>
                 Downloading Pro's models — {downloadLabel(pro.downloaded, pro.total)}
               </Txt>
               <ProgressBar pct={downloadPct(pro.downloaded, pro.total)} color={colors.primary} track={colors.cardAlt} />
               <Txt variant="chip" color={colors.inkFaint}>
                 You can leave this screen. The download carries on in the background while you use the app.
               </Txt>
             </View>
           ) : null}
           {pro.error ? (
             <View style={st.dl}>
               <Txt variant="chip" color={colors.warning}>
                 {`Pro's models did not finish downloading: ${pro.error}`}
               </Txt>
               <Button label="Try again" icon="download" onPress={() => runProModels().catch(() => {})} full />
             </View>
           ) : null}
   ```
   Leave the `{bought ? ( <SoftButton icon="check" label="Close" … /> ) : playCan ? (` that follows
   as it is: Close is always there.
9. The wifi note: replace
   ```tsx
               {!bought && !writerInstalled && writerMb > 0 ? (
                 <Txt variant="chip" color={colors.inkFaint} style={st.note}>
                   Pro downloads a {writerMb} MB model once you start, so start on wifi.
                 </Txt>
               ) : null}
   ```
   with
   ```tsx
               {!bought && proMb > 0 ? (
                 <Txt variant="chip" color={colors.inkFaint} style={st.note}>
                   {`Pro downloads ${proMb} MB of models as soon as you start, so start on wifi.`}
                 </Txt>
               ) : null}
   ```
10. The `INCLUDED` entry titled `'The larger transcriber'`: change its body to
    `'A larger model writes down what was said: slower, and noticeably better with strong accents, ' +`
    `'crosstalk and a bad room.',` (no model name; see Step 8).

Run `npx jest src/screens/__tests__/PaywallScreen.test.tsx` → all pass. `npx tsc --noEmit` → clean.
Mutants: (a) delete `&& route.params?.from !== 'onboarding'` → "leaves the download to setup" fails;
(b) delete the `useEffect` in item 6 → "opened on Pro … picks up" fails.
Commit: `feat(paywall): buying Pro starts Pro's models downloading in the background`.

### Step 8: Settings: no download buttons for Pro's models on Pro, and no model names

**Tests first** in `src/screens/__tests__/SettingsScreen.models.test.tsx`. The rows no longer show
the model's name, so first update what reads it:

1. Line 62: `const metaText = (tree: renderer.ReactTestRenderer) => lines(tree).find(t => t.startsWith('Qwen3 4B ·'));`
   → `const metaText = (tree: renderer.ReactTestRenderer) => lines(tree).find(t => /^[\d.,]+ (MB|GB)\b/.test(t));`
2. Line 141: `.find(n => [n.props.children].flat(Infinity).join('').startsWith('Qwen3 4B ·'));`
   → `.find(n => /^[\d.,]+ (MB|GB)\b/.test([n.props.children].flat(Infinity).join('')));`
3. Line 161: `'Remove Writes the summary (Qwen3 4B)'` → `'Remove Writes the summary'`.
4. Line 164: `expect(metaText(tree)).toBe('Qwen3 4B · 1100 MB');` → `expect(metaText(tree)).toBe('1100 MB');`

Then append:

```tsx
test('no row names its model, only what it is for', async () => {
  const tree = await render();
  expect(lines(tree).some(t => t.includes('Qwen3 4B'))).toBe(false);
  expect(lines(tree)).toContain('Writes the summary');
  await act(async () => tree.unmount());
});

describe("Pro's models are part of Pro, not downloads to manage", () => {
  const pro = (installed: boolean) => ({
    ...model(installed),
    id: 'whisper-small',
    name: 'Whisper small',
    purpose: 'Writes down what was said, more accurately',
    needsSubscription: true,
    sizeBytes: 190_085_487,
  });
  const removeLabel = 'Remove Writes down what was said, more accurately';
  const getLabel = 'Download Writes down what was said, more accurately';

  test('on Pro an installed Pro model offers no Remove', async () => {
    list.mockResolvedValue(JSON.stringify([pro(true)]));
    const tree = await render();
    expect(tree.root.findAllByProps({ accessibilityLabel: removeLabel })).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  test('on Pro a missing Pro model offers no Download either: it arrives by itself', async () => {
    list.mockResolvedValue(JSON.stringify([pro(false)]));
    const tree = await render();
    expect(tree.root.findAllByProps({ accessibilityLabel: getLabel })).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  test('once Pro has lapsed, the file is theirs to remove', async () => {
    const status = Licence.status as unknown as jest.Mock;
    const real = status.getMockImplementation()!;
    const active = await real();
    status.mockResolvedValue({ ...active, paid: false });
    try {
      list.mockResolvedValue(JSON.stringify([pro(true)]));
      const tree = await render();
      expect(tree.root.findAllByProps({ accessibilityLabel: removeLabel }).length).toBeGreaterThan(0);
      await act(async () => tree.unmount());
    } finally {
      status.mockImplementation(real);
    }
  });
});
```

Run the file: the name test and the two Pro tests fail.

**Code** in `src/screens/SettingsScreen.tsx`:

1. The alert title `` `${m.name} is part of the subscription`, `` → `'Part of Pro',`.
2. In the row render, right after `const off = !m.installed && !!m.unsupportedReason;` add:
   ```tsx
               // Part of Pro while Pro lasts: it downloads by itself (src/setup/proModels), so there is
               // nothing to get or remove here. Lapsed, it is their storage again.
               const included = m.needsSubscription && !!lic?.paid;
   ```
   and change `{off ? null : (` (just before `<Pressable onPress={() => onToggle(m)}`) to
   `{off || included ? null : (`.
3. The accessibility label `` `${m.installed ? 'Remove' : 'Download'} ${m.purpose} (${m.name})` ``
   → `` `${m.installed ? 'Remove' : 'Download'} ${m.purpose}` ``.
4. The meta line: delete `{m.name} ·{' '}` so it reads only
   `{busy ? downloadLabel(prog.downloaded, prog.total) : mb(m.sizeBytes)}`.
5. Replace the comment that begins `The job first, the model name after.` (about 4 lines) with:
   `{/* The job only, never the model's name (founder, 21 Oct). The names live on the open-source
       notices screen, which is where the privacy claim is checked. */}`

Run `npx jest src/screens/__tests__/SettingsScreen.models.test.tsx` → all pass.
Mutants: (a) `off || included` → `off` → both Pro tests fail; (b) put `{m.name} ·{' '}` back → the name test fails.
Commit: `feat(settings): Pro's models are not downloads to manage on Pro; rows say what, not which model`.

### Step 9: first-run setup has no switch for the writer

In `src/screens/OnboardingScreen.tsx`:

1. Delete the line
   `{proChosen && !writerBlocked ? <Switch on={wantWriter} onToggle={() => setWantWriter(v => !v)} /> : null}`
   and the two-line comment above it ("No switch when there is nothing to switch on…").
2. In the copy just above, change
   `` `Adds ${writerMb} MB. Without it you still get minutes, pulled out by rule rather than written as prose.` ``
   to `` `Included with Pro: ${writerMb} MB, downloaded with the speech models.` ``.
3. If `Switch` is now unused, remove only its import. Keep the `wantWriter` state: it is still set
   to `entitlement.paid`.

Run `npx jest src/screens/__tests__/OnboardingScreen.test.tsx` → all pass. `npx tsc --noEmit` → clean.
Commit: `feat(onboarding): the writer is part of Pro, not a switch`.

### Step 10: gate and report

`GATE_STAGES="types js scans" scripts/gate.sh 2>&1 | tail -20` must end green.
`git diff --stat e38c958..HEAD` may name only: `src/billing/proDownload.ts`,
`src/billing/planCompare.ts`, `src/screens/ProCompareSheet.tsx`, `src/setup/proModels.ts`,
`src/setup/ProModelsCard.tsx` and their tests (`proDownload.test.ts`, `planCompare.test.ts`,
`ProCompareSheet.test.tsx`, `proModels.test.ts`); `LibraryScreen.tsx`, `ProPill.tsx` (deleted),
`PaywallScreen.tsx`, `SettingsScreen.tsx`, `OnboardingScreen.tsx`; the edited test files
(`LibraryScreen.test.tsx`, `PaywallScreen.test.tsx`, `SettingsScreen.models.test.tsx`); and the report.

`git grep -n "Whisper small\|Qwen3 4B\|Qwen2.5" -- src ':!src/legal' ':!**/__tests__/**' ':!src/graphify-out'`
must print nothing that is shown on a screen (comments are fine; list what it printed in the report).

Write `docs/superpowers/reports/2026-10-21-free-pro-sheet-and-pro-models.md`: §1 the commits; §2
the test and gate output; §3 every mutant and whether it failed a test; §4 every deviation from
this sheet and why; §5 anything left. Commit: `docs(report): 21 Oct - Free-and-Pro sheet, Pro models in the background`.

## 5. Stop conditions

An API outside these files is needed: stop and report. The same failure survives two fixes: stop
and report. A test fails in a file you did not touch: do not investigate; record it in the report.
150 steps: commit and stop.
