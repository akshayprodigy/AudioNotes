# Execution sheet: a calm Library, every download on the front page, Settings in pages

*Written 22 Oct 2026 by Opus for a Sonnet builder. Branch `calm-library-and-settings`, base
`63a3344` (release 1.1.3). Anchors grepped the day of writing. Two sessions: **A** = Steps 1–5,
**B** = Steps 6–9. Each session reads only its own steps.*

**Why (founder, 22 Oct).**
1. The Library header has too many buttons (Import, Search, Actions, Settings). Keep only Search
   and Settings. Import moves to the Record screen as "Or import a recording ›". Actions moves into
   the summary strip: on Pro, its third cell reads ACTIONS · N open, where Free shows FREE LEFT.
2. Any model download in flight must show on the Library, by what it is for, whatever started it
   (setup, the Pro purchase, anything else). Today a writer download is visible only in Settings.
3. No Get or Remove buttons for features. Everything this phone is entitled to downloads by itself,
   and the row only says its status. No screen names a model.
4. Settings becomes a short page of six headings: Plan & account, Recording, Storage & features,
   Privacy, Appearance, About. Each opens its own page.

## 1. Rules

TDD: each test first, watch it fail, then the code. Every named mutant must make a test fail; put
the code back after each one. One commit per step, with the message given. End every message with
`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push. Never run adb or the bare
gate: only `GATE_STAGES="types js scans" scripts/gate.sh`. Indent like the file (2 spaces). Pipe
long output through `tail`/`grep`. `git status` must be clean when you stop. Hand over at 150
steps: commit, then write in the report where you stopped.

## 2. Must not change

Everything under `android/`. `src/setup/essentialDownload.ts`, `src/setup/ReadinessCard.tsx`,
`src/setup/proModels.ts`, `src/screens/useImport.ts`, `src/screens/PaywallScreen.tsx`,
`src/screens/settings/VoicesSection.tsx`, `NoticesScreen.tsx`, `src/legal/`. Every copy string not
named in a step.

---

# Session A (Steps 1–5)

## A.1 Relevant files (read only these lines)

| File | Lines | Why |
|---|---|---|
| `src/screens/summaryStats.ts` | all (~90) | the strip's cells |
| `src/screens/LibrarySummary.tsx` | 1–100 | the strip; its press and footer |
| `src/screens/LibraryScreen.tsx` | 50–55, 228–300, 700–770 | Props/signature; `work`, `useImport`; header, strip, cards |
| `src/screens/RecordScreen.tsx` | 640–660, 729–735 | the allowance line in the idle state; styles |
| `src/navigation/RootNavigator.tsx` | 28–35 | `Library: undefined` |
| `src/setup/ProModelsCard.tsx` | all | becomes error-only |
| `src/screens/downloadLabel.ts` | 25–40 | `downloadLabel`, `downloadPct` |
| `src/screens/__tests__/summaryStats.test.ts` | all | strip stat tests |
| `src/screens/__tests__/LibraryScreen.test.tsx` | 40–80, 300–340, 400–575 | harness; tracker tests; import tests |
| `src/screens/__tests__/RecordScreen.allowance.test.tsx` | 1–80 | harness |

### Step 1: the strip's third cell on Pro is ACTIONS

**Tests first.** Append to `src/screens/__tests__/summaryStats.test.ts`:

```ts
describe('the actions cell (Pro)', () => {
  const PRO = { limit: 5, used: 0, remaining: 5, period: '2026-10', resetsOn: '2026-11-01', paid: true };
  it('on Pro, given the open count, the third cell is ACTIONS', () => {
    const stats = summaryStats(4, 30, PRO, 3);
    expect(stats.map(x => x.key)).toEqual(['saved', 'captured', 'actions']);
    expect(stats[2]).toMatchObject({ label: 'ACTIONS', parts: [{ value: '3', unit: 'open' }], spoken: '3 open actions' });
  });
  it('says one action, not one actions', () => {
    expect(summaryStats(1, 5, PRO, 1)[2].spoken).toBe('1 open action');
  });
  it('without an open count there is no actions cell', () => {
    expect(summaryStats(4, 30, PRO).map(x => x.key)).toEqual(['saved', 'captured']);
  });
});
```

**Code** in `src/screens/summaryStats.ts`:
1. `key: 'saved' | 'captured' | 'free';` → `key: 'saved' | 'captured' | 'free' | 'actions';`
2. Signature → `export function summaryStats(saved: number, capturedMin: number, allowance: AllowanceStatus | null, openActions: number | null = null): Stat[] {`
3. Right before `return out;` add:
   ```ts
     // Pro's third cell: the open actions, where Free counts its meetings. The strip opens the
     // tracker, so the header needs no Actions button (founder, 22 Oct).
     if (openActions !== null) {
       out.push({
         key: 'actions',
         label: 'ACTIONS',
         parts: [{ value: String(openActions), unit: 'open' }],
         spoken: `${openActions} open ${openActions === 1 ? 'action' : 'actions'}`,
       });
     }
   ```

**Code** in `src/screens/LibrarySummary.tsx`:
1. Add the prop `openActions?: number | null; onOpenActions?: () => void;` (in both the
   destructuring and the type) and pass `openActions ?? null` as the 4th argument of `summaryStats`.
2. After the line `const upgrade = …;` add:
   ```tsx
     // On Pro the strip opens the action tracker instead.
     const tracker = onOpenActions && stats.some(x => x.key === 'actions') ? onOpenActions : undefined;
     const press = upgrade ?? tracker;
   ```
3. On the `<Pressable` change: `accessibilityRole={upgrade ? 'button' : undefined}` →
   `accessibilityRole={press ? 'button' : undefined}`; the label →
   `accessibilityLabel={upgrade ? `${spoken} Go unlimited with Pro.` : tracker ? `${spoken} Open the action tracker.` : spoken}`;
   `disabled={!upgrade}` → `disabled={!press}`; `onPress={upgrade}` → `onPress={press}`.
   Leave the `{upgrade ? (… Go unlimited with Pro …) : null}` footer alone.

Run `npx jest src/screens/__tests__/summaryStats.test.ts` → pass.
Mutant: `openActions === 1 ? 'action'` → `'actions'` → test 2 fails.
Commit: `feat(library): the strip's third cell on Pro is the open actions`.

### Step 2: the Library header holds only Search and Settings

**Tests first** in `src/screens/__tests__/LibraryScreen.test.tsx`:

(a) Change the harness so a test can arrive with params:
```tsx
async function focusTheLibrary(params?: { importNow?: number }) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<LibraryScreen navigation={nav} route={{ ...(route as any), params } as never} />);
  });
  return tree;
}
```

(b) Replace the test `'has the tracker one tap away in the header regardless'` with:
```tsx
  it('on Pro the summary strip counts the open actions and opens the tracker', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([
      { id: 'm1', title: 'Standup', createdAt: Date.now(), durationMs: 600_000, language: 'en', status: 'done', tierUsed: 'pro', audioRetained: 1 },
    ]);
    (db.allActions as jest.Mock).mockResolvedValue(rows(3));
    const tree = await focusTheLibrary();
    const strip = tree.root.findAll(n => n.props.testID === 'library-summary', { deep: false })[0];
    expect(strip.props.accessibilityLabel).toContain('3 open actions');
    await act(async () => strip.props.onPress());
    expect((nav as any).navigate).toHaveBeenCalledWith('Actions');
    await act(async () => tree.unmount());
  });
```

(c) Add, next to the header tests (after `'on free the header carries neither a Pro pill nor Actions…'`):
```tsx
  test('the header holds only Search and Settings', async () => {
    const tree = await focusTheLibrary();
    const row = tree.root.findAll(n => n.props.testID === 'library-header', { deep: false })[0];
    const labels = row.findAll(n => typeof n.props.accessibilityLabel === 'string', { deep: false }).map(n => n.props.accessibilityLabel);
    expect(labels).toEqual(['Search meetings', 'Settings']);
    await act(async () => tree.unmount());
  });
```
(If `row.findAll(…, { deep: false })` also returns inner nodes, filter with `new Set(labels)` and
compare to the same two labels; record the change in the report.)

(d) Replace the whole test `'buying Pro on the Pro screen is noticed when the library is focused again'` with
(the header no longer has an Actions button to appear; the strip's actions cell is what Pro gains):
```tsx
  test('buying Pro on the Pro screen is noticed when the library is focused again', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    (db.listMeetings as jest.Mock).mockResolvedValue([
      { id: 'm1', title: 'Standup', createdAt: Date.now(), durationMs: 600_000, language: 'en', status: 'done', tierUsed: 'free', audioRetained: 1 },
    ]);
    const tree = await focusTheLibrary();
    const strip = () => tree.root.findAll(n => n.props.testID === 'library-summary', { deep: false })[0];
    expect(strip().props.accessibilityLabel).not.toContain('open action');

    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const onFocus = (nav as any).addListener.mock.calls.find((c: any[]) => c[0] === 'focus')[1];
    await act(async () => {
      onFocus();
    });
    expect(strip().props.accessibilityLabel).toContain('0 open actions');
    await act(async () => tree.unmount());
  });
```

(e) The seven import tests (search for `pressIconButton(tree, 'Import a recording')`): in each,
replace `const tree = await focusTheLibrary();` + the `await act(async () => { pressIconButton(tree, 'Import a recording'); });`
block with:
```tsx
    const tree = await focusTheLibrary({ importNow: 1 });
    await act(async () => {});
```
Everything else in those tests stays. Rename `'with none left the import button explains…'` to
`'with none left an import explains…'`.

Run the file: the new tests fail.

**Code:**
1. `src/navigation/RootNavigator.tsx`: `Library: undefined;` →
   ```ts
     /** `importNow` (a timestamp): the Record screen's "Or import a recording" hands the pick here. */
     Library: { importNow?: number } | undefined;
   ```
2. `src/screens/LibraryScreen.tsx`:
   - `export default function LibraryScreen({ navigation }: Props) {` → `({ navigation, route }: Props)`.
   - Right after the `const importing = useImport(…);` statement ends, add:
     ```tsx
       // The Record screen's "Or import a recording" lands here: this screen owns the import, its
       // progress line and the share-sheet path, so the pick runs here too.
       const importNow = route.params?.importNow;
       useEffect(() => {
         if (importNow) importing.pick();
         // eslint-disable-next-line react-hooks/exhaustive-deps
       }, [importNow]);
     ```
   - In the header, delete the import `IconButton` (with its 3-line comment) and the
     `{paidKnown && paid ? ( <IconButton … label="Actions" … /> ) : null}` block. What is left in
     `st.headBtns` is the Search and Settings buttons.
   - On `<LibrarySummary …>` add `openActions={paid ? work.open : null}` and
     `onOpenActions={() => navigation.navigate('Actions')}`.

Run `npx jest src/screens/__tests__/LibraryScreen.test.tsx` → pass. `npx tsc --noEmit` → clean.
Mutant: `openActions={paid ? work.open : null}` → `openActions={null}` → test (b) fails.
Commit: `feat(library): the header holds only Search and Settings; actions live in the strip`.

### Step 3: "Or import a recording" on the Record screen

**Test first.** Append to `src/screens/__tests__/RecordScreen.allowance.test.tsx`:
```tsx
test('with meetings left, Record offers an import, which hands the pick to the Library', async () => {
  const tree = await render();
  const link = tree.root.findAll(n => n.props.accessibilityLabel === 'Import a recording' && typeof n.props.onPress === 'function')[0];
  expect(link).toBeDefined();
  await act(async () => link.props.onPress());
  expect(nav.navigate).toHaveBeenCalledWith('Library', { importNow: expect.any(Number) });
  await act(async () => tree.unmount());
});

test('with none left there is no import link: an import would be refused too', async () => {
  allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0 });
  const tree = await render();
  expect(tree.root.findAll(n => n.props.accessibilityLabel === 'Import a recording')).toHaveLength(0);
  await act(async () => tree.unmount());
});
```

**Code** in `src/screens/RecordScreen.tsx`: replace
```tsx
              ) : (
                <AllowanceLine status={allowance} />
              )
```
with
```tsx
              ) : (
                <>
                  <AllowanceLine status={allowance} />
                  {/* The other way to add a meeting. Here, not on the Library header (founder,
                      22 Oct: the header had too many buttons). The Library runs the pick. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Import a recording"
                    hitSlop={8}
                    onPress={() => navigation.navigate('Library', { importNow: Date.now() })}
                    style={st.importLink}>
                    <Txt variant="chip" color={colors.primaryDeep}>
                      Or import a recording ›
                    </Txt>
                  </Pressable>
                </>
              )
```
and add `importLink: { marginTop: s(10), alignSelf: 'center' },` to the object in `makeStyles`.

Run the file → pass. Mutant: delete the `<Pressable …>…</Pressable>` → test 1 fails.
Commit: `feat(record): "Or import a recording" moves here from the Library header`.

### Step 4: every download in flight, as one store

Create `src/setup/__tests__/activeDownloads.test.ts`:

```ts
import ModelManager from '../../native/NativeModelManager';
import { resetActiveDownloadsForTest, shownDownloads, STALE_MS, useActiveDownloads, watchDownloads } from '../activeDownloads';

const list = ModelManager.list as jest.Mock;
const emit = (id: string, downloaded: number, total: number) =>
  (global as any).__TEST_EMIT__('onModelProgress', { id, downloaded, total });
const tick = () => new Promise(r => setImmediate(r));

beforeEach(async () => {
  resetActiveDownloadsForTest();
  list.mockResolvedValue(JSON.stringify([
    { id: 'llm-qwen', purpose: 'Writes the minutes in plain English', required: false },
    { id: 'whisper-base', purpose: 'Writes down what was said', required: true },
  ]));
  watchDownloads(() => 1000);
  await tick();
});
afterEach(() => list.mockResolvedValue('[]'));

describe('active downloads', () => {
  it('holds a download in flight under what it is for', () => {
    emit('llm-qwen', 100, 1000);
    expect(useActiveDownloads.getState().live['llm-qwen']).toMatchObject({
      purpose: 'Writes the minutes in plain English', downloaded: 100, total: 1000, at: 1000,
    });
  });

  it('forgets it the moment it finishes', () => {
    emit('llm-qwen', 100, 1000);
    emit('llm-qwen', 1000, 1000);
    expect(useActiveDownloads.getState().live['llm-qwen']).toBeUndefined();
  });

  it('shows only what the setup card does not, and nothing that has gone quiet', () => {
    emit('llm-qwen', 100, 1000);
    emit('whisper-base', 5, 50);
    const live = useActiveDownloads.getState().live;
    expect(shownDownloads(live, 1000).map(d => d.id)).toEqual(['llm-qwen']);
    expect(shownDownloads(live, 1000 + STALE_MS)).toEqual([]);
  });
});
```

Create `src/setup/activeDownloads.ts`:

```ts
import { NativeEventEmitter, NativeModules } from 'react-native';
import { create } from 'zustand';
import ModelManager from '../native/NativeModelManager';

/**
 * Every model download in flight, from any screen, as one store the Library draws (founder,
 * 22 Oct: whatever is downloading or updating belongs on the front page, not only in Settings).
 * Native sends onModelProgress every 512 KB for whoever started the download (setup, the Pro run,
 * anything else), so listening here sees all of them without any of them knowing about it.
 */
export type Live = { id: string; purpose: string; required: boolean; downloaded: number; total: number; at: number };

type State = { live: Record<string, Live> };

export const useActiveDownloads = create<State>(() => ({ live: {} }));

/** Quiet this long and it has stopped; whoever started it says why (setup card, Pro card). */
export const STALE_MS = 60_000;

let rows: Record<string, { purpose: string; required: boolean }> = {};
let listening = false;

async function loadRows() {
  try {
    const all: { id: string; purpose: string; required: boolean }[] = JSON.parse(await ModelManager.list());
    rows = Object.fromEntries(all.map(m => [m.id, { purpose: m.purpose, required: m.required }]));
  } catch {
    // Keep what we had: a purpose-less row still shows its bytes.
  }
}

/** Test seam. */
export function resetActiveDownloadsForTest() {
  rows = {};
  useActiveDownloads.setState({ live: {} });
}

/** Start listening, once per app process. `now` is a test seam. */
export function watchDownloads(now: () => number = Date.now) {
  loadRows();
  if (listening) return;
  listening = true;
  new NativeEventEmitter(NativeModules.ModelManager).addListener(
    'onModelProgress',
    (e: { id?: string; downloaded: number; total: number }) => {
      const id = e.id;
      if (!id || !(e.total > 0)) return;
      if (e.downloaded >= e.total) {
        useActiveDownloads.setState(s => {
          const { [id]: _done, ...rest } = s.live;
          return { live: rest };
        });
        return;
      }
      const known = rows[id];
      useActiveDownloads.setState(s => ({
        live: {
          ...s.live,
          [id]: { id, purpose: known?.purpose ?? '', required: known?.required ?? false, downloaded: e.downloaded, total: e.total, at: now() },
        },
      }));
      if (!known) {
        // A model this process has not listed yet: fill in its purpose, if it is still in flight.
        loadRows().then(() => {
          const r = rows[id];
          if (!r) return;
          useActiveDownloads.setState(s => (s.live[id] ? { live: { ...s.live, [id]: { ...s.live[id], ...r } } } : s));
        });
      }
    },
  );
}

/**
 * What the Library shows: everything in flight except the required models (the setup card already
 * shows those, with its own Retry), and nothing that has gone quiet.
 */
export function shownDownloads(live: Record<string, Live>, now: number): Live[] {
  return Object.values(live)
    .filter(d => !d.required && now - d.at < STALE_MS)
    .sort((a, b) => a.id.localeCompare(b.id));
}
```

Note: `watchDownloads(() => 1000)` in the test's `beforeEach` only installs the listener on the
FIRST call (module-level `listening`), so `now` is fixed at 1000 for the whole file — which is what
the tests assume. Do not reset `listening` in the test seam.

Run `npx jest src/setup/__tests__/activeDownloads.test.ts` → 3 passed.
Mutants: (a) `e.downloaded >= e.total` → `e.downloaded > e.total` → test 2 fails; (b) delete
`!d.required && ` → test 3 fails.
Commit: `feat(setup): activeDownloads - every model download in flight, by what it is for`.

### Step 5: the Library shows them; the Pro card keeps only its failure

Create `src/setup/DownloadsStrip.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Icon from '../components/Icon';
import { ProgressBar, Txt } from '../components/ui';
import { downloadLabel, downloadPct } from '../screens/downloadLabel';
import { s, useTheme } from '../theme';
import { shownDownloads, useActiveDownloads } from './activeDownloads';

/**
 * What is downloading right now, on the Library, by what it is for. Quiet when nothing is.
 * Not a card: a line and a bar per download, so it informs without taking the screen.
 */
export default function DownloadsStrip() {
  const { colors } = useTheme();
  const live = useActiveDownloads(st => st.live);
  const [now, setNow] = useState(() => Date.now());
  const any = Object.keys(live).length > 0;

  // Only while something is in flight: re-check every few seconds so a download that went quiet
  // drops off rather than sitting at its last percentage.
  useEffect(() => {
    if (!any) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [any]);

  const shown = shownDownloads(live, now);
  if (shown.length === 0) return null;

  return (
    <View style={sx.wrap} testID="downloads-strip">
      {shown.map(d => (
        <View
          key={d.id}
          style={sx.item}
          accessible
          accessibilityLabel={`Downloading: ${d.purpose || 'a feature'}, ${downloadLabel(d.downloaded, d.total)}`}>
          <View style={sx.line}>
            <Icon name="download" size={s(14)} color={colors.primaryDeep} strokeWidth={2.4} />
            <Txt variant="chip" color={colors.ink} style={sx.flex} numberOfLines={1}>
              {d.purpose || 'Downloading a feature'}
            </Txt>
            <Txt variant="chipSoft" color={colors.inkDim}>
              {downloadLabel(d.downloaded, d.total)}
            </Txt>
          </View>
          <ProgressBar pct={downloadPct(d.downloaded, d.total)} color={colors.primary} track={colors.cardAlt} />
        </View>
      ))}
    </View>
  );
}

const sx = StyleSheet.create({
  wrap: { marginHorizontal: s(20), marginTop: s(10), gap: s(10) },
  item: { gap: s(6) },
  line: { flexDirection: 'row', alignItems: 'center', gap: s(6) },
  flex: { flex: 1 },
});
```

In `src/setup/ProModelsCard.tsx`: the progress now shows in the strip, so the card is the failure
only. Change `if (!error && !(running && total > 0)) return null;` to `if (!error) return null;`,
delete the non-error branch (the `<>` with `ProgressBar` and the "it carries on" line) so the error
branch is rendered directly, and remove imports and destructured names that become unused
(`running`, `downloaded`, `total`, `ProgressBar`, `downloadLabel`, `downloadPct`, `tone` if unused).
Update its doc comment's first sentence to: "Pro's background download when it stopped, on the
Library: why, with Try again."

**Tests first** — append to `src/screens/__tests__/LibraryScreen.test.tsx` (import
`resetActiveDownloadsForTest` from `'../../setup/activeDownloads'` and call it in the top-level
`beforeEach`):

```tsx
describe('every download is on the front page', () => {
  const list = (global as any).__TEST_NATIVE_MODULES__.ModelManager.list as jest.Mock;
  afterEach(() => list.mockResolvedValue('[]'));

  test('a download started anywhere shows on the library, by what it is for', async () => {
    list.mockResolvedValue(JSON.stringify([{ id: 'llm-qwen', purpose: 'Writes the minutes in plain English', required: false }]));
    const tree = await focusTheLibrary();
    await act(async () => {});
    await act(async () => {
      emit('onModelProgress', { id: 'llm-qwen', downloaded: 340_000_000, total: 1_117_320_736 });
    });
    const strip = tree.root.findAll(n => n.props.testID === 'downloads-strip', { deep: false });
    expect(strip).toHaveLength(1);
    expect(texts(tree)).toContain('Writes the minutes in plain English');
    await act(async () => {
      emit('onModelProgress', { id: 'llm-qwen', downloaded: 1_117_320_736, total: 1_117_320_736 });
    });
    expect(tree.root.findAll(n => n.props.testID === 'downloads-strip', { deep: false })).toHaveLength(0);
    await act(async () => tree.unmount());
  });
});
```
(`texts`: copy the one-line helper into this describe if it is not in scope. If
`__TEST_NATIVE_MODULES__.ModelManager` is not how this file reaches `ModelManager.list`, import
`ModelManager from '../../native/NativeModelManager'` and use `ModelManager.list as unknown as jest.Mock`.)

**Code** in `src/screens/LibraryScreen.tsx`: import `DownloadsStrip` from `'../setup/DownloadsStrip'`
and `{ watchDownloads }` from `'../setup/activeDownloads'`; add near the other mount effects
```tsx
  // Every model download, whoever started it, shows on this screen (founder, 22 Oct).
  useEffect(() => {
    watchDownloads();
  }, []);
```
and render `<DownloadsStrip />` right after `<ProModelsCard />`.

Run `npx jest src/screens/__tests__/LibraryScreen.test.tsx src/setup` → pass. `npx tsc --noEmit` → clean.
Mutant: delete `<DownloadsStrip />` → the new test fails.
Commit: `feat(library): every download in flight shows on the front page, by what it is for`.

**End of Session A:** run `GATE_STAGES="types js scans" scripts/gate.sh 2>&1 | tail -8`; it must
be clear. Write `docs/superpowers/reports/2026-10-22-calm-library-and-settings.md` §A (commits,
gate, mutants, deviations) and commit it: `docs(report): 22 Oct - session A`. Stop.

---

# Session B (Steps 6–9)

## B.1 Relevant files (read only these lines)

| File | Lines | Why |
|---|---|---|
| `src/screens/SettingsScreen.tsx` | 1–75, 125–135, 480–600, 1060–1146 | imports, `mb`; signature; header + model rows; About + styles |
| `src/screens/SettingsScreen.tsx` | the 11 `SectionRule` lines (grep `SectionRule label=`) | the section starts |
| `src/navigation/RootNavigator.tsx` | 55–58 | `Settings: undefined` |
| `src/screens/__tests__/SettingsScreen.models.test.tsx` | all | harness + row tests |
| `src/screens/__tests__/SettingsScreen.allowance.test.tsx` | 1–70 | harness |

Section starts at base `63a3344` (each block runs from its `<View style={st.ruleWrap}>` line, or
the comment just above it, to the line before the next block's start):

| Block (`SectionRule` label) | Starts at | Page |
|---|---|---|
| ON-DEVICE MODELS | 494 | storage |
| LIBRARY | 596 | storage |
| SUBSCRIPTION | 644 | plan |
| MOVING DEVICES | 744 | storage |
| BEFORE YOU RECORD (+ the `VoicesSection` after it) | 799 | recording |
| VOCABULARY (its 3-line comment starts just above) | 874 | recording |
| PRIVACY | 899 | privacy |
| TRANSCRIPTION | 977 | recording |
| APPEARANCE | 1005 | appearance |
| DIAGNOSTICS (the whole `{crashReportingAvailable() && …}` with its comment) | ~1031 | privacy |
| ABOUT | 1068 | about (runs to the `</ScrollView>`) |

### Step 6: Settings opens on six headings; each opens its own page

**Tests first.** Create `src/screens/__tests__/SettingsScreen.hub.test.tsx` by copying the header of
`SettingsScreen.allowance.test.tsx` (imports, every `jest.mock`, `FREE`, `texts`, `beforeEach`), with
`push: jest.fn()` added to `nav`, and this `render`:

```tsx
async function render(section?: string) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <SettingsScreen navigation={nav} route={{ key: 's', name: 'Settings', params: section ? { section } : undefined } as any} />,
    );
  });
  await act(async () => {});
  return tree;
}

const HEADINGS = ['Plan & account', 'Recording', 'Storage & features', 'Privacy', 'Appearance', 'About'];

test('Settings opens on six headings and nothing else', async () => {
  const tree = await render();
  expect(texts(tree)).toEqual(expect.arrayContaining(['Settings', ...HEADINGS]));
  expect(texts(tree)).not.toContain('SUBSCRIPTION');
  expect(texts(tree)).not.toContain('FEATURES ON THIS PHONE');
  await act(async () => tree.unmount());
});

test('a heading opens its own page', async () => {
  const tree = await render();
  const [row] = tree.root.findAllByProps({ accessibilityLabel: 'Recording' }, { deep: false });
  await act(async () => row.find(n => typeof n.props.onPress === 'function').props.onPress());
  expect(nav.push).toHaveBeenCalledWith('Settings', { section: 'recording' });
  await act(async () => tree.unmount());
});

test('a page shows its own sections and no others, under its own title', async () => {
  const tree = await render('privacy');
  const t = texts(tree);
  expect(t).toContain('Privacy');
  expect(t).toContain('PRIVACY');
  expect(t).not.toContain('SUBSCRIPTION');
  expect(t).not.toContain('FEATURES ON THIS PHONE');
  expect(t).not.toContain('Recording');
  await act(async () => tree.unmount());
});

test('Recording gathers announcing, vocabulary and the language', async () => {
  const tree = await render('recording');
  expect(texts(tree)).toEqual(expect.arrayContaining(['BEFORE YOU RECORD', 'VOCABULARY', 'TRANSCRIPTION']));
  await act(async () => tree.unmount());
});
```

In `SettingsScreen.allowance.test.tsx` change its `render`'s route to
`{ key: 's', name: 'Settings', params: { section: 'plan' } }`; in `SettingsScreen.models.test.tsx`
to `{ key: 's', name: 'Settings', params: { section: 'storage' } }`.

Run the three files: the hub tests fail.

**Code:**
1. `src/navigation/RootNavigator.tsx`: `Settings: undefined;` →
   ```ts
     /** No section: the six headings. A section: that page (founder, 22 Oct: Settings in pages). */
     Settings: { section?: 'plan' | 'recording' | 'storage' | 'privacy' | 'appearance' | 'about' } | undefined;
   ```
2. `src/screens/SettingsScreen.tsx`:
   - Signature: `({ navigation }: Props)` → `({ navigation, route }: Props)`, and as the first line
     of the body: `const section = route.params?.section;`
   - Above the component (after `const mb = …`), add:
     ```tsx
     type Section = NonNullable<NonNullable<RootStackParamList['Settings']>['section']>;

     /** The six headings Settings opens on. Each opens its own page of the sections below. */
     const SECTIONS: { key: Section; icon: IconName; title: string; sub: string }[] = [
       { key: 'plan', icon: 'ai', title: 'Plan & account', sub: 'Your plan, restore a purchase, sign in' },
       { key: 'recording', icon: 'mic', title: 'Recording', sub: 'Announcing, voices, language and vocabulary' },
       { key: 'storage', icon: 'download', title: 'Storage & features', sub: 'What is on this phone, backup, archived meetings' },
       { key: 'privacy', icon: 'shield', title: 'Privacy', sub: 'The audio you keep, and what left this phone' },
       { key: 'appearance', icon: 'sun', title: 'Appearance', sub: 'Light or dark' },
       { key: 'about', icon: 'help', title: 'About', sub: 'Open-source notices' },
     ];
     ```
     (Import `type IconName` from `'../components/Icon'` if it is not imported; `RootStackParamList`
     is already imported for `Props` — check, and import it if not.)
   - Header title: `<Txt variant="sectionTitle">Settings</Txt>` →
     `<Txt variant="sectionTitle">{section ? SECTIONS.find(x => x.key === section)!.title : 'Settings'}</Txt>`
   - Right after `contentContainerStyle={…}>` of the ScrollView, add the hub:
     ```tsx
             {!section ? (
               <View style={st.list}>
                 {SECTIONS.map(x => (
                   <View key={x.key} accessibilityRole="button" accessibilityLabel={x.title}>
                     <Raised
                       edge={colors.line}
                       fill={colors.card}
                       rad={radius.xl}
                       depth={5}
                       onPress={() => navigation.push('Settings', { section: x.key })}>
                       <View style={st.rowPad}>
                         <View style={st.row}>
                           <View style={[st.hubIcon, { backgroundColor: colors.primarySoft }]}>
                             <Icon name={x.icon} size={s(19)} color={colors.primaryDeep} strokeWidth={2.4} />
                           </View>
                           <View style={st.flex}>
                             <Txt variant="bodyStrong">{x.title}</Txt>
                             <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                               {x.sub}
                             </Txt>
                           </View>
                           <Icon name="chevronRight" size={s(18)} color={colors.inkFaint} strokeWidth={2.4} />
                         </View>
                       </View>
                     </Raised>
                   </View>
                 ))}
               </View>
             ) : null}
     ```
     and add `hubIcon: { width: s(38), height: s(38), borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginRight: s(12) },`
     to `makeStyles`.
   - Wrap the blocks of the table above, in file order, so each renders only on its page.
     Neighbouring blocks with the same page share one wrapper:
     - ON-DEVICE MODELS + LIBRARY → `{section === 'storage' ? (<>` … `</>) : null}`
     - SUBSCRIPTION → `{section === 'plan' ? (<>` … `</>) : null}`
     - MOVING DEVICES → `{section === 'storage' ? (<>` … `</>) : null}`
     - BEFORE YOU RECORD + VoicesSection + VOCABULARY → `{section === 'recording' ? (<>` … `</>) : null}`
     - PRIVACY → `{section === 'privacy' ? (<>` … `</>) : null}`
     - TRANSCRIPTION → `{section === 'recording' ? (<>` … `</>) : null}`
     - APPEARANCE → `{section === 'appearance' ? (<>` … `</>) : null}`
     - DIAGNOSTICS → `{section === 'privacy' ? (<>` … `</>) : null}`
     - ABOUT → `{section === 'about' ? (<>` … `</>) : null}`
     **Do not re-indent the wrapped lines** — only the wrapper lines are new. The diff must stay
     reviewable; prettier is not enforced in this repo.
   - Rename `<SectionRule label="ON-DEVICE MODELS" />` → `<SectionRule label="FEATURES ON THIS PHONE" />`.

Run `npx jest src/screens/__tests__/SettingsScreen` → all three files pass. `npx tsc --noEmit` → clean.
Mutants: (a) change the PRIVACY wrapper's `'privacy'` to `'plan'` → hub test 3 fails; (b) change the hub's `{!section ? (` to `{true ? (` → test 3 fails (`Recording` present).
Commit: `feat(settings): six headings, each its own page`.

### Step 7: features show their status, never a button

Create `src/screens/featureStatus.ts`:

```ts
/**
 * A feature's row in Settings says where it stands and offers nothing to press (founder, 22 Oct):
 * everything this phone is entitled to downloads by itself. Pure.
 */
export type FeatureRow = { installed: boolean; needsSubscription: boolean; unsupportedReason?: string | null };
export type FeatureStatus = 'ready' | 'unsupported' | 'downloading' | 'pro' | 'waiting';

export function featureStatus(m: FeatureRow, paid: boolean, downloading: boolean): FeatureStatus {
  if (m.installed) return 'ready';
  if (m.unsupportedReason) return 'unsupported';
  if (downloading) return 'downloading';
  if (m.needsSubscription && !paid) return 'pro';
  return 'waiting';
}

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  ready: 'ON THIS PHONE',
  unsupported: 'NOT ON THIS PHONE',
  downloading: 'DOWNLOADING',
  pro: 'COMES WITH PRO',
  waiting: 'DOWNLOADS BY ITSELF',
};
```

Create `src/screens/__tests__/featureStatus.test.ts`:

```ts
import { featureStatus } from '../featureStatus';

const row = (o: Partial<{ installed: boolean; needsSubscription: boolean; unsupportedReason: string | null }> = {}) => ({
  installed: false, needsSubscription: false, unsupportedReason: null, ...o,
});

describe('featureStatus', () => {
  it('on the phone is on the phone, whatever else is true', () => {
    expect(featureStatus(row({ installed: true, needsSubscription: true }), false, false)).toBe('ready');
  });
  it('a phone that cannot run it says so before anything else', () => {
    expect(featureStatus(row({ unsupportedReason: 'Needs 4 GB.' }), true, true)).toBe('unsupported');
  });
  it('downloading, while it is', () => {
    expect(featureStatus(row({ needsSubscription: true }), true, true)).toBe('downloading');
  });
  it('a Pro feature on Free comes with Pro', () => {
    expect(featureStatus(row({ needsSubscription: true }), false, false)).toBe('pro');
  });
  it('otherwise it is on its way by itself', () => {
    expect(featureStatus(row({ needsSubscription: true }), true, false)).toBe('waiting');
    expect(featureStatus(row(), false, false)).toBe('waiting');
  });
});
```

Run it → 5 passed. Mutant: delete `&& !paid` → test 5 fails.

**Tests next** in `src/screens/__tests__/SettingsScreen.models.test.tsx`:
1. In `'a download that finishes elsewhere clears the row and refreshes the list'`, change
   `expect(texts(tree)).toContain('Remove');` → `expect(texts(tree)).toContain('ON THIS PHONE');`.
2. In `'a model that turns out to be installed does not keep a stale progress entry for later'`,
   change `expect(texts(tree)).toContain('Remove');` → `expect(texts(tree)).toContain('ON THIS PHONE');`
   and delete everything from the comment `// Remove it:` to the `expect(metaText(tree)).toBe('1100 MB');`
   line inclusive, then add `expect(metaText(tree)).toBe('1100 MB');` in its place (the row shows
   its size, not the old 50%).
3. Replace the whole `describe("Pro's models are part of Pro, not downloads to manage", …)` with:

```tsx
describe('features show their status, never a button', () => {
  const pro = (installed: boolean) => ({
    ...model(installed),
    id: 'whisper-small',
    name: 'Whisper small',
    purpose: 'Writes down what was said, more accurately',
    needsSubscription: true,
    sizeBytes: 190_085_487,
  });
  const anyButton = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(n => typeof n.props.accessibilityLabel === 'string' && /^(Remove|Download) /.test(n.props.accessibilityLabel));

  test('no row offers Get or Remove', async () => {
    list.mockResolvedValue(JSON.stringify([model(true), pro(false)]));
    const tree = await render();
    expect(anyButton(tree)).toHaveLength(0);
    expect(texts(tree)).toEqual(expect.arrayContaining(['ON THIS PHONE', 'DOWNLOADS BY ITSELF']));
    await act(async () => tree.unmount());
  });

  test('on Free a Pro feature says it comes with Pro, and the row opens the Pro screen', async () => {
    const status = Licence.status as unknown as jest.Mock;
    const real = status.getMockImplementation()!;
    status.mockResolvedValue({ ...(await real()), paid: false });
    try {
      list.mockResolvedValue(JSON.stringify([pro(false)]));
      const tree = await render();
      expect(texts(tree)).toContain('COMES WITH PRO');
      const [row] = tree.root.findAllByProps({ accessibilityLabel: 'Writes down what was said, more accurately. Comes with Pro.' }, { deep: false });
      await act(async () => row.props.onPress());
      expect(nav.navigate).toHaveBeenCalledWith('Paywall');
      await act(async () => tree.unmount());
    } finally {
      status.mockImplementation(real);
    }
  });

  test("once Pro has lapsed, one button frees the space Pro's features take", async () => {
    const status = Licence.status as unknown as jest.Mock;
    const real = status.getMockImplementation()!;
    status.mockResolvedValue({ ...(await real()), paid: false });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    try {
      list.mockResolvedValue(JSON.stringify([pro(true)]));
      const tree = await render();
      const free = tree.root.findAll(n => n.props.label === "Remove Pro's features (190 MB)" && typeof n.props.onPress === 'function')[0];
      await act(async () => free.props.onPress());
      const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
      await act(async () => buttons.find(b => b.text === 'Remove')!.onPress!());
      expect(ModelManager.remove).toHaveBeenCalledWith('whisper-small');
      await act(async () => tree.unmount());
    } finally {
      status.mockImplementation(real);
      alert.mockRestore();
    }
  });
});
```
(Import `Alert` from `react-native` if the file does not already.)

Run the file: the new tests fail.

**Code** in `src/screens/SettingsScreen.tsx`:
1. Import `{ featureStatus, STATUS_LABEL }` from `'./featureStatus'`.
2. Delete the whole `onToggle` function (from `const onToggle = async (m: Model) => {` to its
   closing `};`). Nothing calls it after this step.
3. In the row render, replace `const off = …;` and the `included` line (with its comment) with:
   ```tsx
               // Where it stands, never a button (founder, 22 Oct): what this phone is entitled to
               // downloads by itself. A Pro feature on Free opens the Pro screen from its row.
               const status = featureStatus(m, !!lic?.paid, busy);
               const off = status === 'unsupported';
               const sellsPro = status === 'pro';
   ```
4. Delete the whole `{off || included ? null : ( <Pressable onPress={() => onToggle(m)} … </Pressable> )}` block.
5. Make the row itself the way to Pro when it sells Pro. Replace the line `<Pop key={m.id} index={i}>`
   with:
   ```tsx
                 <Pop key={m.id} index={i}>
                   <Pressable
                     accessible
                     accessibilityRole={sellsPro ? 'button' : undefined}
                     accessibilityLabel={`${m.purpose}. ${sellsPro ? 'Comes with Pro.' : STATUS_LABEL[status].toLowerCase()}`}
                     disabled={!sellsPro}
                     onPress={() => navigation.navigate('Paywall')}>
   ```
   and add `</Pressable>` on its own line right after the row's closing `</Raised>` (before
   `</Pop>`). `Pressable` is already imported in this file.
6. The tag: replace its background/colour ternaries and its text
   `{off ? 'NOT ON THIS PHONE' : m.needsSubscription ? 'PRO' : m.required ? 'REQUIRED' : 'OPTIONAL'}`
   with:
   ```tsx
                             backgroundColor:
                               status === 'ready'
                                 ? colors.successSoft
                                 : status === 'unsupported'
                                   ? colors.warningSoft
                                   : status === 'pro'
                                     ? colors.cardAlt
                                     : colors.primarySoft,
   ```
   for the background,
   ```tsx
                             status === 'ready'
                               ? colors.success
                               : status === 'unsupported'
                                 ? colors.warning
                                 : status === 'pro'
                                   ? colors.inkFaint
                                   : colors.primary
   ```
   for the text colour, and `{STATUS_LABEL[status]}` for the text.
7. Right after the closing `</View>` of the `st.list` that holds the model rows, add the lapsed
   button:
   ```tsx
           {(() => {
             // Pro lapsed with its features still here: their storage, freed in one go.
             const kept = !lic?.paid ? models.filter(m => m.needsSubscription && m.installed) : [];
             if (kept.length === 0) return null;
             const bytes = kept.reduce((a, m) => a + m.sizeBytes, 0);
             return (
               <View style={st.list}>
                 <SoftButton
                   icon="trash"
                   label={`Remove Pro's features (${mb(bytes)})`}
                   onPress={() =>
                     Alert.alert("Remove Pro's features?", 'They download again by themselves if you take Pro again.', [
                       { text: 'Keep', style: 'cancel' },
                       {
                         text: 'Remove',
                         style: 'destructive',
                         onPress: async () => {
                           for (const m of kept) await ModelManager.remove(m.id).catch(() => {});
                           refresh();
                         },
                       },
                     ])
                   }
                 />
               </View>
             );
           })()}
   ```
   (This sits inside the `section === 'storage'` wrapper from Step 6.)

Run `npx jest src/screens/__tests__/SettingsScreen.models.test.tsx src/screens/__tests__/featureStatus.test.ts` → pass. `npx tsc --noEmit` → clean.
Mutants: (a) `const sellsPro = status === 'pro';` → `= false` → test 2 fails; (b) in the lapsed
button, `!lic?.paid ?` → `lic?.paid ?` → test 3 fails.
Commit: `feat(settings): features show their status, never a button`.

### Step 8: nothing left that names a model or offers a download

Run `git grep -n "label=\"Get\"\|'Get'\|Whisper small\|Qwen3 4B\|Qwen2.5" -- src ':!src/legal' ':!**/__tests__/**' ':!src/graphify-out'`.
It must print nothing a screen shows (comments are fine). List what it printed in the report. No commit
if nothing changed.

### Step 9: gate and report

`GATE_STAGES="types js scans" scripts/gate.sh 2>&1 | tail -8` must end clear.
`git diff --stat 63a3344..HEAD` may name only: `summaryStats.ts`, `LibrarySummary.tsx`,
`LibraryScreen.tsx`, `RecordScreen.tsx`, `RootNavigator.tsx`, `ProModelsCard.tsx`,
`activeDownloads.ts`, `DownloadsStrip.tsx`, `SettingsScreen.tsx`, `featureStatus.ts`, their tests
(`summaryStats.test.ts`, `LibraryScreen.test.tsx`, `RecordScreen.allowance.test.tsx`,
`activeDownloads.test.ts`, `SettingsScreen.hub.test.tsx`, `SettingsScreen.models.test.tsx`,
`SettingsScreen.allowance.test.tsx`, `featureStatus.test.ts`), this sheet and the report.

Add §B to `docs/superpowers/reports/2026-10-22-calm-library-and-settings.md` (commits, gate, every
mutant and whether it failed a test, every deviation and why, what is left). Commit:
`docs(report): 22 Oct - session B`.

## 5. Stop conditions

An API outside these files is needed: stop and report. The same failure survives two fixes: stop
and report. A test fails in a file you did not touch: do not investigate; record it in the report.
150 steps: commit and stop.
