# Execution sheet: the count opens Free-and-Pro; buying Pro downloads Pro's models at once

*Written 21 Oct 2026 by Opus for a Sonnet builder. Base: branch `pro-models-and-free-sheet` at
`bba043f` (the native half is already done there: `AsrChoice.kt`, Pro now transcribes with
whisper-small once it is on the phone). Anchors grepped the day of writing.*

**Why (founder, 21 Oct).** (1) The Pro pill clutters the Library header. Take it out. Tapping the
"3 of 5" count, which is where people already look when they think about the limit, opens a sheet
with Free beside Pro and a **Get Pro** button that opens the Pro screen. (2) Pro means better
models, not only more meetings. After a purchase every Pro model this phone can run downloads at
once. The buyer stays on the Pro screen until the download finishes: no Close button and no back.
Pro models stop being optional anywhere: Settings has no Remove for them on Pro, and first-run
setup has no switch for the writer.

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
| `src/screens/SettingsScreen.tsx` | 432–470, 496–545 | `onToggle`; the model row's Remove/Get button |
| `src/screens/OnboardingScreen.tsx` | 505–520 | the writer row's copy and Switch |
| `src/screens/deviceFit.ts` | 1–30 | `runnable`, `sizeMb`, `writerBlockedReason` |
| `src/billing/allowanceCopy.ts` | 60–80 | `statusLine` |
| `src/screens/__tests__/LibraryScreen.test.tsx` | 1–80, 125–180, 380–455 | harness; header tests; allowance tests |
| `src/screens/__tests__/PaywallScreen.test.tsx` | 1–80, 100–125 | harness; the buy tests |
| `src/screens/__tests__/SettingsScreen.models.test.tsx` | 1–90 | harness |

## 3. Must not change

All native code (`android/`). `AllowanceNote.tsx`, `LibrarySummary.tsx`, `allowanceCopy.ts`,
`proHighlights.ts`, `trial.ts`, `subscription.ts`. Every gate other than the Library count:
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

### Step 5: the Paywall downloads every Pro model at once and holds the screen

**Tests first** in `src/screens/__tests__/PaywallScreen.test.tsx`:

1. Add the import `import ModelManager from '../../native/NativeModelManager';` under the other imports.
2. Change `const nav = { navigate: jest.fn(), goBack: jest.fn() } as any;` to
   `const nav = { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;`
3. Append at the END of the file:

```tsx
describe("after buying, Pro's models download at once and the screen holds", () => {
  const rows = [
    { id: 'whisper-base', kind: 'asr', sizeBytes: 59_707_625, installed: true, needsSubscription: false, unsupportedReason: null },
    { id: 'whisper-small', kind: 'asr', sizeBytes: 190_085_487, installed: false, needsSubscription: true, unsupportedReason: null },
    { id: 'llm-qwen', kind: 'llm', sizeBytes: 1_100_000_000, installed: false, needsSubscription: true, unsupportedReason: null },
    { id: 'embed-bge-small', kind: 'llm', sizeBytes: 36_000_000, installed: false, needsSubscription: true, unsupportedReason: null },
  ];
  const list = ModelManager.list as jest.Mock;
  const download = ModelManager.download as jest.Mock;
  const closes = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(n => n.props.label === 'Close' && typeof n.props.onPress === 'function');
  let finish: Array<(v?: unknown) => void>;

  beforeEach(() => {
    finish = [];
    list.mockResolvedValue(JSON.stringify(rows));
    download.mockImplementation(() => new Promise(r => finish.push(r)));
  });
  afterEach(() => {
    list.mockResolvedValue('[]');
    download.mockReset();
  });

  async function buy(params?: { from?: 'onboarding' | 'export' }) {
    sellsPlans([monthlyTrial, annualTrial]);
    (buyWithPlay as jest.Mock).mockResolvedValue({ paid: true });
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render(params);
    (entitlement as jest.Mock).mockResolvedValue({ paid: true, licence: { paid: true } });
    await act(async () => {
      tree.root.findByProps({ label: 'Try it free for 7 days' }).props.onPress();
    });
    await act(async () => {});
    return tree;
  }
  const finishAll = async () => {
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        finish[i]();
      });
    }
  };

  it('fetches every Pro model this phone runs, smallest first, without a tap', async () => {
    const tree = await buy();
    await finishAll();
    expect(download.mock.calls.map(c => c[0])).toEqual(['embed-bge-small', 'whisper-small', 'llm-qwen']);
    expect(closes(tree).length).toBeGreaterThan(0);
    await act(async () => tree.unmount());
  });

  it('while it downloads there is no Close, and back is refused', async () => {
    const tree = await buy();
    expect(download).toHaveBeenCalledTimes(1);
    expect(closes(tree)).toHaveLength(0);
    const held = nav.addListener.mock.calls.filter((c: any[]) => c[0] === 'beforeRemove');
    expect(held.length).toBeGreaterThan(0);
    const e = { preventDefault: jest.fn() };
    held[held.length - 1][1](e);
    expect(e.preventDefault).toHaveBeenCalled();
    await finishAll();
    await act(async () => tree.unmount());
  });

  it('a failed download says why and offers Try again; only then may the buyer leave', async () => {
    download.mockRejectedValueOnce(new Error('No connection'));
    const tree = await buy();
    expect(texts(tree)).toContain("Pro's models did not finish downloading: No connection");
    expect(closes(tree).length).toBeGreaterThan(0);
    await act(async () => {
      tree.root.findAll(n => n.props.label === 'Try again' && typeof n.props.onPress === 'function')[0].props.onPress();
    });
    expect(download).toHaveBeenCalledTimes(2);
    await finishAll();
    await act(async () => tree.unmount());
  });

  it('opened on Pro with a model missing, the screen finishes the download by itself', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true, licence: { paid: true } });
    const tree = await render();
    expect(download).toHaveBeenCalledWith('embed-bge-small');
    await finishAll();
    await act(async () => tree.unmount());
  });

  it('from first run, a purchase leaves the download to setup', async () => {
    const tree = await buy({ from: 'onboarding' });
    expect(nav.goBack).toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });
});
```

Run `npx jest src/screens/__tests__/PaywallScreen.test.tsx`: the new tests fail.

**Code** in `src/screens/PaywallScreen.tsx`:

1. Imports: add `import { proToFetch } from '../billing/proDownload';`. In the `./deviceFit`
   import, keep only what is still used after this step (`sizeMb, spaceFits, spaceReason,
   writerBlockedReason`; `runnable` goes, and tsc/eslint will tell you if anything else does).
2. Delete the `writerMb` and `writerInstalled` state (lines 175–179, with their comment). Right
   after the `const [dl, setDl] = …` line add:
   ```tsx
     // What a subscription still has to put on THIS phone, and its size. Read on open. Buying puts
     // nothing on disk, so the same answer still holds straight after the purchase.
     const [proTodo, setProTodo] = useState(0);
     const [proMb, setProMb] = useState(0);
     // 'running' holds the buyer on this screen, with no Close and no back, until every Pro model
     // is on the phone (founder, 21 Oct: Pro is the better models, not an optional download).
     // 'failed' says why and offers Try again. Only then may they leave.
     const [fetching, setFetching] = useState<'running' | 'failed' | null>(null);
     const [fetchError, setFetchError] = useState<string | null>(null);
     // Bytes of the models already finished in this run, and the whole run's size. Native's
     // progress event covers one model at a time; the bar covers all of them.
     const doneBytes = useRef(0);
     const runBytes = useRef(0);
     const autoStarted = useRef(false);
   ```
3. In the `ModelManager.list()` effect: add `needsSubscription: boolean;` to the row type of
   `all`. Replace everything from `const writer = runnable(...)` to the end of the `if
   (pendingBytes > 0) { … }` block with:
   ```tsx
           setWriterBlocked(writerBlockedReason(all));
           // What buying would fetch, quoted under the button and checked against the disk.
           const todo = proToFetch(all);
           setProTodo(todo.length);
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
   (Keep the `setWriterBlocked` call only once: the original line goes into this block.)
4. Replace the progress listener's body:
   ```tsx
       const sub = emitter.addListener('onModelProgress', (e: { total: number; downloaded: number }) => {
         // Only during this screen's own run. Setup or Settings downloading something else is not
         // Pro's progress.
         if (e.total > 0 && runBytes.current > 0) {
           setDl({ downloaded: doneBytes.current + e.downloaded, total: runBytes.current });
         }
       });
   ```
5. Replace the whole `fetchWriter` (its doc comment and the `useCallback`) with:
   ```tsx
     /**
      * Put every Pro model this phone can run onto it, straight after the purchase, or whenever
      * this screen opens on Pro with one missing. Smallest first. Held: see `fetching`.
      */
     const fetchPro = useCallback(async () => {
       autoStarted.current = true;
       scroller.current?.scrollTo({ y: 0, animated: true });
       setFetching('running');
       setFetchError(null);
       try {
         const todo = proToFetch(JSON.parse(await ModelManager.list()));
         runBytes.current = todo.reduce((a, m) => a + m.sizeBytes, 0);
         doneBytes.current = 0;
         setDl({ downloaded: 0, total: runBytes.current });
         for (const m of todo) {
           await ModelManager.download(m.id);
           doneBytes.current += m.sizeBytes;
           setDl({ downloaded: doneBytes.current, total: runBytes.current });
         }
         setProTodo(0);
         setFetching(null);
       } catch (e: any) {
         setFetchError(String(e?.message ?? e));
         setFetching('failed');
       } finally {
         runBytes.current = 0;
         setDl(null);
       }
     }, []);
   ```
6. In `onBuy`, delete the line `await fetchWriter();` and change the deps array to
   `[chosenPlan, plans, load, navigation, route.params]`. The effect in step 7 starts the
   download once `load()` reports the purchase.
7. Right after the line `const bought = Boolean(ent?.licence?.paid);` add:
   ```tsx

     // Bought, and Pro's models are not all here: straight after a purchase, after a restore, or
     // when a download that failed or was cut off gets finished by opening this screen again. First
     // run is the exception: setup's own Download button fetches them, and two runs would race.
     useEffect(() => {
       if (!bought || proTodo === 0 || autoStarted.current || route.params?.from === 'onboarding') return;
       fetchPro();
     }, [bought, proTodo, fetchPro, route.params]);

     // The hold: back (gesture, hardware or goBack) does nothing while Pro's models download.
     useEffect(() => {
       if (fetching !== 'running') return;
       return navigation.addListener('beforeRemove', e => e.preventDefault());
     }, [fetching, navigation]);
   ```
8. Header: replace `<IconButton icon="x" label="Close" onPress={() => navigation.goBack()} />`
   with
   `{fetching === 'running' ? null : <IconButton icon="x" label="Close" onPress={() => navigation.goBack()} />}`,
   and in `makeStyles` change `nav` to
   `nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: s(20), minHeight: s(40) },`
   so the hero does not jump up when the button goes.
9. `SignInForm`'s `onSignedIn={res => { if (res.paid) navigation.goBack(); }}` →
   `onSignedIn={res => { if (res.paid) load(); }}`. A web subscriber signing in here gets their
   models the same way a buyer does.
10. The dock: replace the `{dl !== null ? ( … ) : null}` block and the
    `{bought ? ( <SoftButton icon="check" label="Close" … /> ) : playCan ? (` opening with:
    ```tsx
            {dl !== null ? (
              <View style={st.dl}>
                <Txt variant="chip" color={colors.inkSoft}>
                  Downloading Pro's models — {downloadLabel(dl.downloaded, dl.total)}
                </Txt>
                <ProgressBar pct={downloadPct(dl.downloaded, dl.total)} color={colors.primary} track={colors.cardAlt} />
                <Txt variant="chip" color={colors.inkFaint}>
                  Keep Verbale open until this finishes. Pro's more accurate transcript and written minutes run on these models.
                </Txt>
              </View>
            ) : null}
            {fetching === 'failed' ? (
              <View style={st.dl}>
                <Txt variant="chip" color={colors.warning}>
                  {`Pro's models did not finish downloading: ${fetchError}`}
                </Txt>
                <Txt variant="chip" color={colors.inkFaint}>
                  Try again now. If you close this, opening Pro again finishes it.
                </Txt>
                <Button label="Try again" icon="download" onPress={fetchPro} full />
              </View>
            ) : null}
            {bought ? (
              fetching === 'running' ? null : (
                <SoftButton icon="check" label="Close" onPress={() => navigation.goBack()} />
              )
            ) : playCan ? (
    ```
11. The wifi note: replace
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

Run `npx jest src/screens/__tests__/PaywallScreen.test.tsx` → all pass. `npx tsc --noEmit` → clean.
Mutants: (a) `e => e.preventDefault()` → `() => {}` → "no Close, and back is refused" fails;
(b) delete `|| route.params?.from === 'onboarding'` → "leaves the download to setup" fails;
(c) in step 10 change `fetching === 'running' ? null :` to `false ? null :` → the hold test fails.
Commit: `feat(paywall): buying Pro downloads every Pro model at once, and holds until it is done`.

### Step 6: Settings: Pro models are part of Pro, not optional downloads

**Tests first.** Append to `src/screens/__tests__/SettingsScreen.models.test.tsx`:

```tsx
describe("Pro's models are part of Pro, not optional downloads", () => {
  const pro = (installed: boolean) => ({
    ...model(installed),
    id: 'whisper-small',
    name: 'Whisper small',
    purpose: 'Writes down what was said, more accurately',
    needsSubscription: true,
    sizeBytes: 190_085_487,
  });
  const removeLabel = 'Remove Writes down what was said, more accurately (Whisper small)';
  const getLabel = 'Download Writes down what was said, more accurately (Whisper small)';

  test('on Pro an installed Pro model offers no Remove', async () => {
    list.mockResolvedValue(JSON.stringify([pro(true)]));
    const tree = await render();
    expect(tree.root.findAllByProps({ accessibilityLabel: removeLabel })).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  test('on Pro a missing Pro model opens the Pro screen, which finishes the download', async () => {
    list.mockResolvedValue(JSON.stringify([pro(false)]));
    const tree = await render();
    await act(async () => {
      tree.root.findByProps({ accessibilityLabel: getLabel }).props.onPress();
    });
    expect(nav.navigate).toHaveBeenCalledWith('Paywall');
    expect(ModelManager.download).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  test('once Pro has lapsed, the file is still theirs to remove', async () => {
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

Run it: tests 1 and 2 fail.

**Code** in `src/screens/SettingsScreen.tsx`:

1. In `onToggle`, right after the closing `}` of the `if (m.needsSubscription && !lic?.paid) { … return; }` block, add:
   ```tsx
       if (m.needsSubscription) {
         // Paid, and a Pro model is missing (a download that failed or was cut off). The Pro screen
         // finishes it the way it does after a purchase, held until every Pro model is here, so
         // Pro's models arrive one way and not two.
         navigation.navigate('Paywall');
         return;
       }
   ```
2. In the row render, right after `const off = !m.installed && !!m.unsupportedReason;` add:
   ```tsx
               // Part of Pro while Pro lasts: nothing to remove. Lapsed, it is their storage again.
               const included = m.installed && m.needsSubscription && !!lic?.paid;
   ```
   and change `{off ? null : (` (the one just before `<Pressable onPress={() => onToggle(m)}`)
   to `{off || included ? null : (`.

Run `npx jest src/screens/__tests__/SettingsScreen.models.test.tsx` → all pass.
Mutants: (a) `off || included` → `off` → test 1 fails; (b) delete the new `if (m.needsSubscription) { … }` block → test 2 fails.
Commit: `feat(settings): Pro models are part of Pro - no Remove on Pro, a missing one opens the Pro screen`.

### Step 7: first-run setup has no switch for the writer

In `src/screens/OnboardingScreen.tsx`:

1. Delete the line
   `{proChosen && !writerBlocked ? <Switch on={wantWriter} onToggle={() => setWantWriter(v => !v)} /> : null}`
   and the two-line comment above it ("No switch when there is nothing to switch on…").
2. In the copy just above, change
   `` `Adds ${writerMb} MB. Without it you still get minutes, pulled out by rule rather than written as prose.` ``
   to
   `` `Included with Pro: ${writerMb} MB, downloaded with the speech models.` ``.
3. If `Switch` or `setWantWriter` is now unused, tsc/eslint will say so. Remove only the unused
   import of `Switch`; keep `wantWriter` state (it is still set to `entitlement.paid`).

Run `npx jest src/screens/__tests__/OnboardingScreen.test.tsx` → all pass. `npx tsc --noEmit` → clean.
Commit: `feat(onboarding): the writer is part of Pro, not a switch`.

### Step 8: gate and report

`GATE_STAGES="types js scans" scripts/gate.sh 2>&1 | tail -20` must end green.
`git diff --stat bba043f..HEAD` may name only: the 6 new files (`proDownload.ts`, `planCompare.ts`,
`ProCompareSheet.tsx` and their 3 tests), `LibraryScreen.tsx`, `ProPill.tsx` (deleted),
`PaywallScreen.tsx`, `SettingsScreen.tsx`, `OnboardingScreen.tsx`, the 3 edited test files, and
the report.

Write `docs/superpowers/reports/2026-10-21-free-pro-sheet-and-pro-models.md`: §1 the commits; §2
the test and gate output; §3 every mutant and whether it failed a test; §4 every deviation from
this sheet and why; §5 anything left. Commit: `docs(report): 21 Oct - Free-and-Pro sheet, Pro models at purchase`.

## 5. Stop conditions

An API outside these files is needed: stop and report. The same failure survives two fixes: stop
and report. A test fails in a file you did not touch: do not investigate; record it in the report.
150 steps: commit and stop.
