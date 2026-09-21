# Phase 5 — Session 2 execution sheet (screens: dictation on the Record screen, the labels, Settings › Vocabulary, the rule offer)

*21 September 2026, against `09d8037`. For the session that builds it. Do not design anything: every
file, function, string and test below is decided. Execute the steps in order. Session 1 (native and
data) is built and reviewed: `db.mode`, `db.vocabulary()`, `db.putVocabulary()`, `db.deleteVocabulary()`,
`db.applyVocabulary()`, `Meeting.mode`, `AudioPipeline.start({ mode })` all exist. The one piece of
logic this session needs — `proposeRule(before, after)` in `src/screens/meeting/vocabularyRule.ts` —
is written and golden-tested; call it, never edit it. Nothing here opens a model or touches Kotlin
beyond one label map.*

**Two runs.** Session 2A = Steps 1–4. Session 2B = Steps 5–8. Each run starts from the progress file.

---

## 0. Rules

- **Token discipline.** Read only the files and line ranges in §1. Never print a file over 200 lines;
  `grep -n` then `sed -n 'A,Bp'` at most 60 lines at a time. `MeetingScreen.tsx` is 1,500 lines,
  `SettingsScreen.tsx` 1,075, `LibraryScreen.tsx` 993: only the ranges named. Every command below ends
  in its filter — run it exactly. Do not re-read a file after editing it. Do not paste code into your
  messages; commit it.
- **TDD + mutant.** Test first, see it fail, code, see it pass, apply the named mutant, see the test
  fail, restore, green. Record each mutant in the progress file's *Mutants* as it happens.
- **Commit after each step**, subject in the house style (`git log --oneline -6`). Never push. Never
  run `connectedDebugAndroidTest`. **`git status` must be clean before you stop.** **Indent like the
  surrounding file: two spaces, TypeScript and Kotlin alike; JSX attributes one per line when the tag
  wraps, as the neighbours do.**
- **Progress file.** First action: open `docs/superpowers/reports/phase-5-progress.md` and append a
  `## Session 2` heading with the eight steps of §2 as checkboxes; keep the existing *Decisions*,
  *Mutants*, *Notes for the next session* headings and add to them. Update and commit it with every step.
- **Hand-over at 150 steps**, whatever remains: finish the step you are on, commit, update the progress
  file, stop. Stop also when a §6 condition is met.
- **No device.** Nothing in this session needs the phone. Do not run `adb`.

---

## 1. Relevant files (the only files you read)

| File | Lines | Why |
|---|---|---|
| `src/screens/meeting/vocabularyRule.ts` | all (44) | the function Step 7 calls — read, never edit |
| `src/screens/meeting/templateLabels.ts` | all (44) | Step 1: add the dictation label |
| `cpp/tests/golden/template_labels.json` | all (14) | Step 1: one row |
| `android/.../pipeline/TemplateLabels.kt` | all (24) | Step 1: the Kotlin mirror, one line |
| `src/screens/meeting/SummaryTab.tsx` | 13, 208–215, 300–325 | Step 1: the chip and the speakers line |
| `src/screens/meeting/__tests__/SummaryTab.test.tsx` | 1–100 | Step 1: the chip tests to extend |
| `src/screens/__tests__/templateLabels.test.ts` | all (30) | Step 1: reads the golden; no edit |
| `src/db/queries.ts` | 104–114 (`listMeetings`) | Step 2: select `mode` |
| `src/screens/LibraryScreen.tsx` | 420–428, 494–500 | Step 2: the two card meta lines |
| `src/screens/__tests__/LibraryScreen.test.tsx` | 1–75, 236–252 | Step 2: the harness and a test to copy |
| `src/screens/MeetingScreen.tsx` | 1–56 (imports), 254–256, 500–512, 540–552, 1040–1060 | Steps 2 and 7 |
| `src/screens/__tests__/MeetingScreen.test.tsx` | 1–70, 391–440 | Steps 2 and 7: the harness and the long-press helpers |
| `src/state/recordingStore.ts` | 1–35 | Step 3 |
| `src/pipeline/PipelineController.ts` | 1–12, 138–150 | Step 3 |
| `src/screens/RecordScreen.tsx` | 1–30, 60–100, 190–225, 355–390, 486–500 | Step 4 |
| `src/navigation/RootNavigator.tsx` | 9–25, 26–56, 160–165 | Step 5 |
| `src/screens/ArchiveScreen.tsx` | all (158) | Step 5: the list-screen shape to copy |
| `src/components/confirm.ts` | all (32) | Step 5: `confirmDestructive` |
| `src/screens/__tests__/VoicesSection.test.tsx` | 1–30 | Step 5: the test conventions (fake timers, Alert spy) |
| `src/screens/SettingsScreen.tsx` | 26–37, 284–286, 812–832, 1029–1045 | Step 6 |

**Interfaces you use without reading their files** (they exist; do not open them):
`db.vocabulary(): Promise<VocabularyRule[]>`, `db.putVocabulary(heard, meant, 'typed'|'learned'): Promise<string>`,
`db.deleteVocabulary(id): Promise<void>`, `db.applyVocabulary(meetingId): Promise<number>`,
`db.getSetting(key): Promise<string|null>`, `db.setSetting(key, value): Promise<unknown>`,
`VocabularyRule { id, heard, meant, source: 'typed'|'learned', createdAt, uses }` and `Meeting.mode?: 'dictation'|null`
from `src/pipeline/types`, `entitlement(): Promise<{ paid: boolean }>` from `src/billing/trial`,
`Segmented`, `TextPrompt`, `SoftButton`, `IconButton`, `Raised`, `Pop`, `Txt`, `SectionRule` from
`src/components/ui`, `Mascot` from `src/components/Mascot`, `Icon` from `src/components/Icon`,
`radius, s, sv, tilt, useTheme, type Colors` from `src/theme`. Icon names that exist: `plus`, `edit`,
`trash`, `chevronRight`, `chevronLeft`, `check`, `x`.

**Files that must not change:** anything under `cpp/` except the one golden row; every `.kt` except
`TemplateLabels.kt`; `src/db/schema.ts`; `src/db/queries.ts` except `listMeetings`; `src/native/**`;
`src/components/**`; `src/theme/**`; `src/pipeline/**` except `PipelineController.ts`; `jest.setup.js`;
`src/screens/meeting/TranscriptTab.tsx`; `src/screens/meeting/vocabularyRule.ts` and its golden and
test; `src/screens/PaywallScreen.tsx`; every test not named below.

---

## 2. Implementation sequence

### Session 2A

### Step 1 — "Dictation" is a label, and a dictated note's chip is not a choice

**1a.** `cpp/tests/golden/template_labels.json`: after the `site_walk` row add
`{ "id": "dictation", "label": "Dictation" },` and change the note's "the seven ids" to
"the seven ids … plus `dictation`, the fixed type of a dictated note (Phase 5)".

**1b.** Run the two golden readers and see both fail on the new row:
`npx jest src/screens/__tests__/templateLabels.test.ts --forceExit --silent 2>&1 | tail -6` → 1 failed;
`cd android && ./gradlew :app:testDebugUnitTest --tests '*TemplateLabelsTest*' -q 2>&1 | grep -E "FAILED|BUILD" | tail -3` → FAILED.

**1c.** `src/screens/meeting/templateLabels.ts`: after the `TemplateId` type line add

```ts
/**
 * Phase 5: the type a dictated note is fixed to. Not in TEMPLATE_IDS on purpose — it is never
 * offered in the sheet, and a meeting never becomes one by choice; the Record screen's mode is
 * what makes it.
 */
export const DICTATION_TEMPLATE = 'dictation';
```

and change `templateLabel`'s body to

```ts
  if (id === DICTATION_TEMPLATE) return 'Dictation';
  return id && isTemplateId(id) ? LABEL[id] : 'General';
```

`TemplateLabels.kt`: after `"site_walk" to "Site walk",` add `"dictation" to "Dictation",` (Phase 5 comment
on the line above it: `// Phase 5: the fixed type of a dictated note; never offered, never suggested.`).
Both readers green: jest 12 passed (10 table rows + the two fixed tests), Kotlin `TemplateLabelsTest` failures 0.

**1d.** `SummaryTab.tsx`. Line 13: import `DICTATION_TEMPLATE` alongside `TEMPLATE_IDS`. Replace the
chip `Pressable` (the one whose `accessibilityLabel` is `` `Meeting type: ${templateLabel(template)}` ``)
and the `Txt` after it (the `{mins} min · …` line) with:

```tsx
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Meeting type: ${templateLabel(template)}`}
                // Phase 5: a dictated note's type is fixed — the chip is a label, not a choice.
                disabled={template === DICTATION_TEMPLATE}
                onPress={() => setTemplateSheetOpen(true)}
                style={st.templateChip}>
                <Txt variant="chipSoft" color={colors.onPrimary}>
                  {templateLabel(template)}
                </Txt>
              </Pressable>
              <Txt variant="chipSoft" color={colors.onPrimary} style={st.dim}>
                {mins} min ·{' '}
                {template === DICTATION_TEMPLATE
                  ? 'one voice'
                  : `${speakers.length || '—'} ${speakers.length === 1 ? 'speaker' : 'speakers'}`}
              </Txt>
```

**1e.** `SummaryTab.test.tsx`, inside `describe('the meeting-type chip')` after the `'a null template
reads as General'` test, add:

```tsx
  test('a dictated note reads Dictation, says one voice, and the chip is not a choice', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const tree = await renderTab({ template: 'dictation', speakers: [] });
    const chip = tree.root.findAllByProps(
      { accessibilityLabel: 'Meeting type: Dictation' },
      { deep: false },
    )[0];
    expect(chip).toBeDefined();
    expect(chip.props.disabled).toBe(true);
    const texts = tree.root
      .findAll(n => typeof n.props.children === 'string')
      .map(n => n.props.children as string);
    expect(texts.some(t => t.includes('one voice'))).toBe(true);
    expect(texts.some(t => t.includes('speakers'))).toBe(false);
  });
```

Run: `npx jest src/screens/meeting/__tests__/SummaryTab.test.tsx --forceExit --silent 2>&1 | tail -6` → all passed.
*Mutants:* remove the `"dictation" to "Dictation"` line from `TemplateLabels.kt` → Kotlin `TemplateLabelsTest`
fails; change `disabled={template === DICTATION_TEMPLATE}` to `disabled={false}` → the new test fails;
change `'one voice'` to `'1 speaker'` → the new test fails (the `speakers` assertion). Restore.

Commit: `feat(dictation): the Dictation label — chip fixed, one voice`.

### Step 2 — where a dictated note says so: the Library card and the meeting header

**2a.** `src/db/queries.ts` `listMeetings`: change
`'diar_skipped_reason AS diarSkippedReason ' +` to `'diar_skipped_reason AS diarSkippedReason, mode ' +`.

**2b.** `LibraryScreen.tsx`: both card meta lines (line ~425 and ~498) read
`{[when(m.createdAt), dur(m.durationMs)].filter(Boolean).join(' · ')}`. Change both to
`{[m.mode === 'dictation' ? 'Dictation' : null, when(m.createdAt), dur(m.durationMs)].filter(Boolean).join(' · ')}`.

**2c.** `LibraryScreen.test.tsx`, after the `'badges a paused meeting …'` test, add:

```tsx
/** Phase 5: a dictated note says so on its card, before the date. */
test('a dictated note wears Dictation on its card', async () => {
  (db.listMeetings as jest.Mock).mockResolvedValue([{
    id: 'm1', title: 'Note to Priya', createdAt: Date.now(), durationMs: 90_000, language: 'en',
    status: 'done', tierUsed: 'free', audioRetained: 1, mode: 'dictation',
  }]);
  const tree = await focusTheLibrary();
  expect(JSON.stringify(tree.toJSON())).toContain('Dictation · ');
  await act(async () => tree.unmount());
});
```

**2d.** `MeetingScreen.tsx` header (line ~1050): the date `Txt` reads
`{meeting?.createdAt ? new Date(meeting.createdAt).toLocaleString(undefined, {…}) : ''}`. Change it to

```tsx
          <Txt variant="chipSoft" color={colors.inkFaint}>
            {(meeting?.mode === 'dictation' ? 'Dictation · ' : '') +
              (meeting?.createdAt
                ? new Date(meeting.createdAt).toLocaleString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })
                : '')}
          </Txt>
```

**2e.** `MeetingScreen.test.tsx`, after the `'a marked moment shows as a highlight …'` test, add:

```tsx
/** Phase 5: a dictated note says so in its header, before the date. */
test('a dictated note wears Dictation in the header', async () => {
  (db.getMeeting as jest.Mock).mockResolvedValue({
    id: 'm1', title: 'Note to Priya', createdAt: 1, durationMs: 60_000, status: 'done',
    tierUsed: 'free', language: 'en', audioPath: null, audioRetained: 1, mode: 'dictation',
  });
  const tree = await render();
  const texts = tree.root
    .findAll(n => typeof n.props.children === 'string')
    .map(n => n.props.children as string);
  expect(texts.some(t => t.startsWith('Dictation · '))).toBe(true);
});
```

Run: `npx jest src/screens/__tests__/LibraryScreen.test.tsx src/screens/__tests__/MeetingScreen.test.tsx --forceExit --silent 2>&1 | tail -6` → all passed;
`npx tsc --noEmit 2>&1 | tail -3` → nothing.
*Mutants:* in `listMeetings` drop `, mode` → no test fails (the screens are mocked) — record it as
"covered by the by-hand run, §7 step 4"; change the Library prefix to `'Meeting'` → 2c fails; drop the
header prefix → 2e fails. Restore.

Commit: `feat(dictation): Dictation on the library card and the meeting header`.

### Step 3 — the mode reaches native: store, controller, and a pure helper for the Record screen's words

**3a.** Create `src/screens/recordMode.ts`:

```ts
/**
 * Phase 5: what the Record screen offers before the first word — a meeting of several people, or
 * one person dictating a note. The choice is remembered (`record_mode`) and stamped on the meeting
 * at creation; everything downstream (no diarization, spoken marks, the note as the write-up) reads
 * `meetings.mode`, never this setting.
 */
export type RecordMode = 'meeting' | 'dictation';

export const RECORD_MODE_KEY = 'record_mode';

export const RECORD_MODES: { key: RecordMode; label: string }[] = [
  { key: 'meeting', label: 'Meeting' },
  { key: 'dictation', label: 'Dictation' },
];

/** The stored value, or `meeting` for anything else — a blank, an old build's typo, null. */
export function recordModeOf(stored: string | null | undefined): RecordMode {
  return stored === 'dictation' ? 'dictation' : 'meeting';
}

export function modeLabel(mode: RecordMode): string {
  return mode === 'dictation' ? 'Dictation' : 'Meeting';
}

/** The standing line under the clock while idle. `capMs > 0` is the free tier's limit. */
export function idleHint(mode: RecordMode, capMs: number): string {
  const verb = mode === 'dictation' ? 'Tap to dictate' : 'Tap to start recording';
  return capMs > 0 ? `${verb} · up to 15 min on Free` : verb;
}

/** Shown under the mode switch in dictation only: the marks are spoken, and this is the list. */
export const DICTATION_TIP =
  'Say “full stop”, “comma”, “question mark”, “new line” and “new paragraph” — they become the marks.';
```

**3b.** Create `src/screens/__tests__/recordMode.test.ts`:

```ts
import { DICTATION_TIP, RECORD_MODES, idleHint, modeLabel, recordModeOf } from '../recordMode';

describe('recordModeOf', () => {
  it('reads dictation, and meeting for everything else', () => {
    expect(recordModeOf('dictation')).toBe('dictation');
    expect(recordModeOf('meeting')).toBe('meeting');
    expect(recordModeOf(null)).toBe('meeting');
    expect(recordModeOf(undefined)).toBe('meeting');
    expect(recordModeOf('Dictation')).toBe('meeting');
  });
});

describe('the words', () => {
  it('offers the two modes in this order with these labels', () => {
    expect(RECORD_MODES).toEqual([
      { key: 'meeting', label: 'Meeting' },
      { key: 'dictation', label: 'Dictation' },
    ]);
    expect(modeLabel('meeting')).toBe('Meeting');
    expect(modeLabel('dictation')).toBe('Dictation');
  });

  it('keeps the free cap in the hint for both modes', () => {
    expect(idleHint('meeting', 900_000)).toBe('Tap to start recording · up to 15 min on Free');
    expect(idleHint('meeting', 0)).toBe('Tap to start recording');
    expect(idleHint('dictation', 900_000)).toBe('Tap to dictate · up to 15 min on Free');
    expect(idleHint('dictation', 0)).toBe('Tap to dictate');
  });

  it('names all five marks the C++ understands, and neither noun', () => {
    for (const m of ['full stop', 'comma', 'question mark', 'new line', 'new paragraph']) {
      expect(DICTATION_TIP).toContain(`“${m}”`);
    }
    expect(DICTATION_TIP).not.toContain('period');
    expect(DICTATION_TIP).not.toContain('colon');
  });
});
```

**3c.** `src/state/recordingStore.ts`: line 11 becomes
`start: (language: string | null, mode?: 'dictation') => Promise<void>;` and line 25–26 become

```ts
  start: async (language, mode) => {
    const sessionId = await PipelineController.startRecording(language, mode);
```

`src/pipeline/PipelineController.ts` `startRecording` (line ~144) becomes

```ts
  async startRecording(language: string | null, mode?: 'dictation'): Promise<string> {
    const ent = await entitlement().catch(() => null);
    const capMs = capMsFor(Boolean(ent?.paid));
    // Phase 5: the key is absent for a meeting, not null — AudioPipelineModule reads hasKey("mode").
    return AudioPipeline.start({ sampleRate: 16000, language, capMs, ...(mode ? { mode } : {}) });
  }
```

**3d.** Create `src/pipeline/__tests__/startRecording.test.ts`:

```ts
import AudioPipeline from '../../native/NativeAudioPipeline';
import { PipelineController } from '../PipelineController';

/** Phase 5: dictation reaches native as `mode`; a meeting sends no such key at all. */
test('startRecording passes the mode through, and only when there is one', async () => {
  (AudioPipeline.start as jest.Mock).mockClear();
  await PipelineController.startRecording(null, 'dictation');
  expect((AudioPipeline.start as jest.Mock).mock.calls[0][0]).toMatchObject({
    sampleRate: 16000, language: null, mode: 'dictation',
  });
  await PipelineController.startRecording('en');
  expect((AudioPipeline.start as jest.Mock).mock.calls[1][0]).not.toHaveProperty('mode');
  expect((AudioPipeline.start as jest.Mock).mock.calls[1][0]).toMatchObject({ language: 'en' });
});
```

Run: `npx jest src/screens/__tests__/recordMode.test.ts src/pipeline/__tests__/startRecording.test.ts --forceExit --silent 2>&1 | tail -6` → all passed;
`npx tsc --noEmit 2>&1 | tail -3` → nothing.
*Mutants:* `recordModeOf` returns `'dictation'` for `'Dictation'` (case-insensitive compare) → its test fails;
in `startRecording` pass `mode` unconditionally (`{ …, mode }`) → the `not.toHaveProperty` assertion
fails; drop `'question mark'` from `DICTATION_TIP` → the marks test fails. Restore.

Commit: `feat(dictation): the mode reaches native — store, controller, the Record screen's words`.

### Step 4 — the Record screen: Meeting | Dictation

All in `src/screens/RecordScreen.tsx`. No test file exists for this screen and none is added: the
words are pinned in Step 3, the wiring is `tsc` plus the by-hand run.

**4a.** Line 26 `import { Button, IconButton, Pop, Raised, SoftButton, Txt } from '../components/ui';`
→ add `Segmented` in alphabetical place. After line 27 (`recordingCap` import) add
`import { DICTATION_TIP, RECORD_MODES, RECORD_MODE_KEY, idleHint, modeLabel, recordModeOf, type RecordMode } from './recordMode';`.

**4b.** After `const [lifting, setLifting] = useState(false);` (line ~87) add

```tsx
  // Phase 5: meeting or dictation. Read once with the consent flag; written back on every change.
  const [mode, setMode] = useState<RecordMode>('meeting');
```

In the consent `useEffect` (line ~92), after the `announceRecording` chain's `.catch(() => setAnnounceOn(true));` add

```tsx
    db.getSetting(RECORD_MODE_KEY)
      .then(v => setMode(recordModeOf(v)))
      .catch(() => {});
```

After that `useEffect` add

```tsx
  const onChangeMode = (key: string) => {
    const next = recordModeOf(key);
    setMode(next);
    db.setSetting(RECORD_MODE_KEY, next).catch(() => {});
  };
```

**4c.** Line ~217 `await start(null);` → `await start(null, mode === 'dictation' ? 'dictation' : undefined);`.

**4d.** Top bar (line ~364): `Meeting ·{' '}` → `{modeLabel(mode)} ·{' '}`.

Directly after the `</View>` that closes `st.topBar` (before `<View style={st.stage}>`) insert

```tsx
        {/* Phase 5: meeting or dictation, chosen before the first word. Kept mounted while recording —
            dimmed and inert, not removed — so the stage does not jump under the finger. */}
        <View style={[st.modeRow, isRecording && st.modeDim]} pointerEvents={isRecording ? 'none' : 'auto'}>
          <Segmented items={RECORD_MODES} value={mode} onChange={onChangeMode} />
          {mode === 'dictation' && !isRecording ? (
            <Txt variant="chip" color={colors.inkSoft} style={st.modeTip}>
              {DICTATION_TIP}
            </Txt>
          ) : null}
        </View>
```

The idle hint (line ~383–386): replace the two-branch `capMs > 0 ? 'Tap to start recording · up to 15 min on Free' : 'Tap to start recording'`
with `idleHint(mode, capMs)` so the block reads

```tsx
            {!isRecording
              ? idleHint(mode, capMs)
              : paused
              ? 'Paused — tap resume to continue'
              : 'Listening — tap to finish'}
```

**4e.** Styles, after `statusPill: …` (line ~493):

```ts
    modeRow: { marginTop: s(14), gap: s(8) },
    modeDim: { opacity: 0.45 },
    modeTip: { textAlign: 'center', paddingHorizontal: s(8) },
```

Run: `npx tsc --noEmit 2>&1 | tail -3` → nothing; `npx jest --silent 2>&1 | tail -6` → all suites passed
(the full run, once, because RecordScreen has no suite of its own).
Copy check: `grep -c "idleHint(mode, capMs)\|{modeLabel(mode)} ·\|DICTATION_TIP" src/screens/RecordScreen.tsx` → 3.

Commit: `feat(dictation): Meeting | Dictation on the Record screen, remembered`.

**End of Session 2A.** Update the progress file (Steps 1–4 ticked, mutants recorded), commit, stop.

### Session 2B

### Step 5 — Settings › Vocabulary: the screen

**5a.** `src/navigation/RootNavigator.tsx`: after `import NoticesScreen …` add
`import VocabularyScreen from '../screens/VocabularyScreen';`; in `RootStackParamList` after `Notices: undefined;`
add `/** Phase 5: the correction rules, Pro (Settings › Vocabulary). */` and `Vocabulary: undefined;`;
after the `Notices` `Stack.Screen` line add
`<Stack.Screen name="Vocabulary" component={VocabularyScreen} options={{ headerShown: false }} />`.

**5b.** Create `src/screens/VocabularyScreen.tsx` — `ArchiveScreen.tsx` is the shape; this is the whole file:

```tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import Mascot from '../components/Mascot';
import { confirmDestructive } from '../components/confirm';
import { IconButton, Pop, Raised, SoftButton, TextPrompt, Txt } from '../components/ui';
import type { VocabularyRule } from '../pipeline/types';
import { radius, s, sv, tilt, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Vocabulary'>;

/**
 * Settings › Vocabulary (Phase 5): the words it should write. "in over" → "Innova", typed here or
 * learned from a correction in a transcript, applied to every recording after recognition. Whole
 * words, any case; the recogniser's own wording is kept underneath, so a wrong rule costs nothing
 * that cannot be undone by removing it.
 *
 * One screen, like the archive: every row exists to be acted on, so its two actions sit on the
 * card. Adding takes the prompt's two fields — what it hears, then what you mean — because the pair
 * is the rule; changing takes one, because `heard` is the key and only `meant` is ever wrong.
 */
export default function VocabularyScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [rules, setRules] = useState<VocabularyRule[]>([]);
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<VocabularyRule | null>(null);

  const load = useCallback(() => {
    db.vocabulary().then(setRules).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    return navigation.addListener('focus', load);
  }, [navigation, load]);

  const fail = (e: unknown) => Alert.alert('Could not save that', String((e as any)?.message ?? e));

  const onAdd = (heard: string, meant: string) => {
    setAdding(false);
    if (!meant.trim()) {
      Alert.alert('Both are needed', 'Type what it hears, then what you mean.');
      return;
    }
    db.putVocabulary(heard, meant, 'typed').then(load).catch(fail);
  };

  const onChange = (value: string) => {
    const r = changing;
    setChanging(null);
    if (!r) return;
    db.putVocabulary(r.heard, value, r.source).then(load).catch(fail);
  };

  const remove = (r: VocabularyRule) =>
    confirmDestructive({
      title: `Remove “${r.heard}” → “${r.meant}”?`,
      message: 'Lines it already corrected stay as they are. New recordings will not apply it.',
      confirmLabel: 'Remove',
      onConfirm: () => {
        db.deleteVocabulary(r.id).then(load).catch(fail);
      },
    });

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <Txt variant="sectionTitle" style={st.flex}>
          Vocabulary
        </Txt>
        <SoftButton label="Add" icon="plus" onPress={() => setAdding(true)} />
      </View>

      <FlatList
        data={rules}
        keyExtractor={r => r.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          st.listPad,
          { paddingBottom: insets.bottom + s(24) },
          rules.length === 0 && st.emptyPad,
        ]}
        ListEmptyComponent={
          <View style={st.empty}>
            <Mascot mood="asleep" size={sv(120)} />
            <Txt variant="display" style={st.emptyTitle}>
              No words yet
            </Txt>
            <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
              Add a name, a company or a term it keeps mis-hearing, or say Yes when a correction in
              a transcript offers to remember it.
            </Txt>
          </View>
        }
        renderItem={({ item, index }) => (
          <Pop index={index} style={st.rowWrap}>
            <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5} rotate={tilt(index)}>
              <View style={st.card}>
                <Txt variant="cardTitleSm" numberOfLines={2}>
                  {`“${item.heard}” → “${item.meant}”`}
                </Txt>
                <Txt variant="chipSoft" color={colors.inkFaint} style={st.meta}>
                  {(item.source === 'learned' ? 'Learned from a correction' : 'Typed') +
                    ` · used ${item.uses} ${item.uses === 1 ? 'time' : 'times'}`}
                </Txt>
                <View style={st.actions}>
                  <SoftButton label="Change" icon="edit" onPress={() => setChanging(item)} />
                  <SoftButton label="Remove" icon="trash" tone={colors.danger} onPress={() => remove(item)} />
                </View>
              </View>
            </Raised>
          </Pop>
        )}
      />

      <TextPrompt
        visible={adding}
        title="Add a word"
        hint="What it hears, then what you mean. Whole words, any case; the original wording is kept."
        initial=""
        placeholder="What it hears — e.g. in over"
        extraPlaceholder="What you mean — e.g. Innova"
        confirmLabel="Add"
        onCancel={() => setAdding(false)}
        onSubmit={onAdd}
      />
      <TextPrompt
        visible={changing !== null}
        title={changing ? `Instead of “${changing.heard}”` : ''}
        hint="What it should write."
        initial={changing?.meant ?? ''}
        placeholder="What you mean"
        confirmLabel="Save"
        onCancel={() => setChanging(null)}
        onSubmit={onChange}
      />
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20) },
    listPad: { paddingHorizontal: s(20), paddingTop: s(16) },
    emptyPad: { flexGrow: 1, justifyContent: 'center' },
    rowWrap: { marginBottom: s(12) },
    card: { padding: s(16) },
    meta: { marginTop: s(6) },
    actions: { flexDirection: 'row', gap: s(10), marginTop: s(14) },
    empty: { alignItems: 'center', paddingHorizontal: s(20) },
    emptyTitle: { marginTop: s(18) },
    emptyBody: { textAlign: 'center', marginTop: s(6) },
  });
}
```

**5c.** Create `src/screens/__tests__/VocabularyScreen.test.tsx`:

```tsx
import React from 'react';
import { Alert } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import VocabularyScreen from '../VocabularyScreen';
import { TextPrompt } from '../../components/ui';
import { db } from '../../db/queries';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const nav = { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => () => {}) } as any;
const route = { key: 'vocabulary', name: 'Vocabulary', params: undefined } as any;

const rule = (over: Partial<{ id: string; heard: string; meant: string; source: string; uses: number }> = {}) => ({
  id: 'v1', heard: 'in over', meant: 'Innova', source: 'typed', createdAt: 1, uses: 3, ...over,
});

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<VocabularyScreen navigation={nav} route={route} />);
  });
  return tree;
}

const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

const press = async (tree: renderer.ReactTestRenderer, label: string) => {
  const n = tree.root.findAllByProps({ label }, { deep: false })[0];
  await act(async () => {
    n.props.onPress();
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (db.vocabulary as jest.Mock).mockResolvedValue([]);
  (db.putVocabulary as jest.Mock).mockResolvedValue('v1');
  (db.deleteVocabulary as jest.Mock).mockResolvedValue(undefined);
});
afterEach(() => jest.useRealTimers());

test('empty: the mascot line, and no rule rows', async () => {
  const tree = await render();
  expect(texts(tree)).toContain('No words yet');
  expect(tree.root.findAllByProps({ label: 'Remove' }, { deep: false })).toHaveLength(0);
});

test('a rule row reads heard → meant, its source and its uses', async () => {
  (db.vocabulary as jest.Mock).mockResolvedValue([rule(), rule({ id: 'v2', heard: 'prey', meant: 'Priya', source: 'learned', uses: 1 })]);
  const tree = await render();
  const t = texts(tree);
  expect(t).toContain('“in over” → “Innova”');
  expect(t).toContain('Typed · used 3 times');
  expect(t).toContain('Learned from a correction · used 1 time');
});

test('Add: both fields become a typed rule, and the list reloads', async () => {
  const tree = await render();
  await press(tree, 'Add');
  const prompt = tree.root.findAllByType(TextPrompt).find(p => p.props.visible)!;
  expect(prompt.props.title).toBe('Add a word');
  expect(prompt.props.extraPlaceholder).toBe('What you mean — e.g. Innova');
  await act(async () => prompt.props.onSubmit('in over', 'Innova'));
  expect(db.putVocabulary).toHaveBeenCalledWith('in over', 'Innova', 'typed');
  expect(db.vocabulary).toHaveBeenCalledTimes(2);
});

test('Add with the second field empty stores nothing and says both are needed', async () => {
  const tree = await render();
  await press(tree, 'Add');
  const prompt = tree.root.findAllByType(TextPrompt).find(p => p.props.visible)!;
  await act(async () => prompt.props.onSubmit('in over', ''));
  expect(db.putVocabulary).not.toHaveBeenCalled();
  expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Both are needed');
});

test('Change: a one-field prompt keyed on heard, keeping the source', async () => {
  (db.vocabulary as jest.Mock).mockResolvedValue([rule({ source: 'learned' })]);
  const tree = await render();
  await press(tree, 'Change');
  const prompt = tree.root.findAllByType(TextPrompt).find(p => p.props.visible)!;
  expect(prompt.props.title).toBe('Instead of “in over”');
  expect(prompt.props.initial).toBe('Innova');
  expect(prompt.props.extraPlaceholder).toBeUndefined();
  await act(async () => prompt.props.onSubmit('Innova Ltd', ''));
  expect(db.putVocabulary).toHaveBeenCalledWith('in over', 'Innova Ltd', 'learned');
});

test('Remove asks first; Remove deletes, Cancel does not', async () => {
  (db.vocabulary as jest.Mock).mockResolvedValue([rule()]);
  const tree = await render();
  await press(tree, 'Remove');
  expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Remove “in over” → “Innova”?');
  expect(db.deleteVocabulary).not.toHaveBeenCalled();
  const buttons: any[] = (Alert.alert as jest.Mock).mock.calls[0][2];
  expect(buttons.find(b => b.text === 'Cancel').onPress).toBeUndefined();
  await act(async () => buttons.find(b => b.text === 'Remove').onPress());
  expect(db.deleteVocabulary).toHaveBeenCalledWith('v1');
});
```

Run: `npx jest src/screens/__tests__/VocabularyScreen.test.tsx --forceExit --silent 2>&1 | tail -6` → 6 passed;
`npx tsc --noEmit 2>&1 | tail -3` → nothing.
*Mutants:* in `onAdd` pass `'learned'` instead of `'typed'` → the Add test fails; in `onChange` pass
`'typed'` instead of `r.source` → the Change test fails; remove the `!meant.trim()` guard → the
both-are-needed test fails; in `remove` call `db.deleteVocabulary(r.id)` directly instead of inside
`onConfirm` → the Remove test's `not.toHaveBeenCalled()` fails. Restore.

Commit: `feat(vocab): Settings › Vocabulary — the screen`.

### Step 6 — Settings › Vocabulary: the row

`src/screens/SettingsScreen.tsx`. Directly after the `)}` that closes the `{voicesRemember === null ? null : (<VoicesSection … />)}`
block (line ~827) and before `<View style={st.ruleWrap}>` + `<SectionRule label="PRIVACY" />`, insert:

```tsx
        {/* Phase 5: the words it should write. Pro, like every cross-meeting memory — but the row is
            shown to everyone so it can be found, and on free it opens the paywall. `voicesPaid` is the
            entitlement Settings already holds; it is not about voices. */}
        <View style={st.ruleWrap}>
          <SectionRule label="VOCABULARY" />
        </View>
        <View style={st.list}>
          <Raised
            edge={colors.line}
            fill={colors.card}
            rad={radius.xl}
            depth={5}
            onPress={() => navigation.navigate(voicesPaid ? 'Vocabulary' : 'Paywall')}>
            <View style={[st.rowPad, st.row]}>
              <View style={st.flex}>
                <Txt variant="bodyStrong">
                  {voicesPaid ? 'Words it should write' : 'Words it should write (Pro)'}
                </Txt>
                <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                  Names, companies and terms it keeps mis-hearing — “in over” becomes “Innova”. Applied
                  after recognition to every recording; the original wording is kept.
                </Txt>
              </View>
              <Icon name="chevronRight" size={s(18)} color={colors.inkFaint} strokeWidth={2.4} />
            </View>
          </Raised>
        </View>
```

No test file exists for SettingsScreen and none is added. Run: `npx tsc --noEmit 2>&1 | tail -3` → nothing.
Copy check: `grep -c "Words it should write" src/screens/SettingsScreen.tsx` → 1;
`grep -c "navigate(voicesPaid ? 'Vocabulary' : 'Paywall')" src/screens/SettingsScreen.tsx` → 1.

Commit: `feat(vocab): Settings › Vocabulary — the row, Pro`.

### Step 7 — "Correct the words" offers a rule

`src/screens/MeetingScreen.tsx`.

**7a.** Line 20 `import { shouldOfferPaywall } from '../billing/trial';` → `import { entitlement, shouldOfferPaywall } from '../billing/trial';`.
After line 46 (`import { usePlayer } from './meeting/usePlayer';`) add
`import { proposeRule } from './meeting/vocabularyRule';`.

**7b.** Directly before the doc comment that begins `/**` + ` * Save a correction, or a newly typed item.`
(line ~502) insert

```tsx
  /**
   * Phase 5: a correction that is one substitution of one to three words — "in over" → "Innova" —
   * is offered once as a rule. Yes stores it as `learned` and re-runs the rules over this meeting;
   * No stores nothing. Pro only: a free user's correction stays a correction. `proposeRule` decides
   * what counts; this only asks.
   */
  const offerRule = useCallback(
    async (before: string, after: string) => {
      const rule = proposeRule(before, after);
      if (!rule) return;
      const ent = await entitlement().catch(() => null);
      if (!ent?.paid) return;
      Alert.alert(
        `Always write “${rule.meant}” when it hears “${rule.heard}”?`,
        'Applies to the rest of this meeting and to every recording after it. Change or remove it in Settings › Vocabulary.',
        [
          { text: 'No', style: 'cancel' },
          {
            text: 'Yes',
            onPress: () => {
              db.putVocabulary(rule.heard, rule.meant, 'learned')
                .then(() => db.applyVocabulary(meetingId))
                .then(() => refresh())
                .catch(() => {});
            },
          },
        ],
      );
    },
    [meetingId, refresh],
  );

```

**7c.** In `onSaveEdit`, after `await db.putEdit(meetingId, kind, key, value);` (line ~544) add

```tsx
        if (kind === 'utterance') void offerRule(spec.initial, value);
```

and add `offerRule` to `onSaveEdit`'s dependency list: `[editing, meetingId, refresh]` → `[editing, meetingId, refresh, offerRule]`.

**7d.** `MeetingScreen.test.tsx`: at the end of the file add

```tsx
/**
 * Phase 5: "Correct the words" offers the one substitution it finds as a rule, once, on Pro. Yes
 * stores it as learned and re-runs the rules over this meeting; No and free store nothing.
 */
describe('a correction offered as a rule', () => {
  const { TextPrompt } = require('../../components/ui');
  const licence = () => (global as any).__TEST_NATIVE_MODULES__.Licence;
  const utts = [
    { id: 'u1', meetingId: 'm1', startMs: 0, endMs: 2000, speakerId: 's1', text: 'we sold it to in over last week' },
  ];
  const openScript = async (tree: renderer.ReactTestRenderer) => {
    const tab = tree.root.findAllByProps({ accessibilityRole: 'tab', accessibilityLabel: 'Script' })[0];
    await act(async () => {
      tab.props.onPress();
    });
  };
  const correct = async (tree: renderer.ReactTestRenderer, to: string) => {
    const line = tree.root.findAllByProps({ accessibilityLabel: utts[0].text }, { deep: false })[0];
    await act(async () => {
      line.props.onLongPress();
    });
    const row = tree.root.findAllByProps({ accessibilityLabel: 'Correct the words' }, { deep: false })[0];
    await act(async () => {
      row.props.onPress();
    });
    const prompt = tree.root.findAllByType(TextPrompt).find((p: any) => p.props.visible)!;
    await act(async () => prompt.props.onSubmit(to, ''));
  };

  const PAID = {
    plan: 'unlicensed-build', state: 'active', paid: true, expiresAt: 0, account: null,
    lapsedCopy: 'Your subscription has ended.',
  };
  // Persistent, not `Once`: SummaryTab asks entitlement() on mount, before the correction does.
  afterEach(() => licence().status.mockResolvedValue(PAID));

  beforeEach(() => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (db.utterances as jest.Mock).mockResolvedValue(utts);
    (db.speakers as jest.Mock).mockResolvedValue([
      { id: 's1', meetingId: 'm1', clusterLabel: 'S0', displayName: 'Speaker 1' },
    ]);
    (db.putEdit as jest.Mock).mockResolvedValue(undefined);
    (db.putVocabulary as jest.Mock).mockResolvedValue('v1');
    (db.applyVocabulary as jest.Mock).mockResolvedValue(1);
  });

  it('asks, and Yes stores a learned rule and re-runs it over this meeting', async () => {
    const tree = await render();
    await openScript(tree);
    await correct(tree, 'we sold it to Innova last week');
    expect(db.putEdit).toHaveBeenCalledWith('m1', 'utterance', 'u1', 'we sold it to Innova last week');
    expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Always write “Innova” when it hears “in over”?');
    const buttons: any[] = (Alert.alert as jest.Mock).mock.calls[0][2];
    expect(buttons.find(b => b.text === 'No').onPress).toBeUndefined();
    const before = (db.utterances as jest.Mock).mock.calls.length;
    await act(async () => buttons.find(b => b.text === 'Yes').onPress());
    expect(db.putVocabulary).toHaveBeenCalledWith('in over', 'Innova', 'learned');
    expect(db.applyVocabulary).toHaveBeenCalledWith('m1');
    expect((db.utterances as jest.Mock).mock.calls.length).toBeGreaterThan(before);
  });

  it('does not ask for a rewrite', async () => {
    const tree = await render();
    await openScript(tree);
    await correct(tree, 'nothing like the original at all');
    expect(db.putEdit).toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('does not ask on free', async () => {
    licence().status.mockResolvedValue({ ...PAID, plan: 'free', state: 'none', paid: false });
    const tree = await render();
    await openScript(tree);
    await correct(tree, 'we sold it to Innova last week');
    expect(db.putEdit).toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(db.putVocabulary).not.toHaveBeenCalled();
  });
});
```

`Alert` must be imported at the top of the test: `import { Alert } from 'react-native';` after the React import.

Run: `npx jest src/screens/__tests__/MeetingScreen.test.tsx src/screens/__tests__/ItemProvenance.test.tsx --forceExit --silent 2>&1 | tail -6` → all passed
(ItemProvenance runs too because it renders the same screen);
`npx tsc --noEmit 2>&1 | tail -3` → nothing.
*Mutants:* store the rule as `'typed'` → test 1 fails; drop the `if (!ent?.paid) return;` line → test 3
fails; drop `.then(() => db.applyVocabulary(meetingId))` → test 1 fails on `applyVocabulary`;
call `offerRule` for every `kind` (drop `kind === 'utterance'`) → no test here fails — record it as
covered by ItemProvenance's item-edit tests staying green only because those edits are rewrites; note
it in *Mutants* as a surviving mutant. Restore.

Commit: `feat(vocab): Correct the words offers the substitution as a rule — Yes learns it`.

### Step 8 — gate, report, hand-over

**8a.** Gate: `GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh > /tmp/gate.log 2>&1; grep -E "^==>|ok |FAIL|all clear" /tmp/gate.log` → `gate: all clear`.
If a stage fails in a file this session did not touch: §6.

**8b.** Write `docs/superpowers/reports/2026-09-21-phase-5-vocabulary-and-dictation.md` with the nine
sections of `docs/superpowers/reports/2026-09-18-phase-4-remembered-voices.md` (grep its `^## ` lines
for the headings; do not read its body): 1 Status (one line); 2 What was built (Session 1 from the
progress file, then this session, by step); 3 Decisions taken (copy the progress file's *Decisions*);
4 Tests (a table: file · tests · result · mutants tried · result); 5 Gate (the summary lines);
6 Device — write exactly: "Not run — Session 3 is the device session. Session 1's Step 7
(VocabularyDbTest, the probe, device-verify CLASSES) is still open and is listed there."; 7 For the
founder to test by hand — copy §7 below verbatim; 8 Known gaps (the surviving mutants from *Mutants*,
and: "no RecordScreen or SettingsScreen render test — the wiring is `tsc` + §7"); 9 Commits
(`git log --oneline 09d8037..HEAD`).

**8c.** Progress file: tick Step 8, fill *Notes for the next session* with the names Session 3 needs
(`record_mode`, `DICTATION_TEMPLATE`, the screen route `Vocabulary`, the Alert title), commit, **stop**.

---

## 3. Expected interfaces after this session

```ts
// templateLabels.ts
export const DICTATION_TEMPLATE = 'dictation'; templateLabel('dictation') === 'Dictation'; TEMPLATE_IDS unchanged (7)
// recordMode.ts
type RecordMode = 'meeting' | 'dictation'; RECORD_MODE_KEY = 'record_mode'; RECORD_MODES; recordModeOf(v); modeLabel(m); idleHint(m, capMs); DICTATION_TIP
// recordingStore
start(language: string | null, mode?: 'dictation'): Promise<void>
// PipelineController
startRecording(language: string | null, mode?: 'dictation'): Promise<string>   // mode key absent unless dictation
// RootStackParamList
Vocabulary: undefined
// queries.ts
listMeetings(...) rows carry `mode`
// SummaryTab
chip disabled when template === 'dictation'; meta says "one voice"
// MeetingScreen
offerRule(before, after): Alert "Always write “<meant>” when it hears “<heard>”?" — No | Yes
```

Settings keys: `record_mode` ∈ {`meeting`, `dictation`}. Copy that must appear verbatim: `Words it should write`,
`Add a word`, `Both are needed`, `No words yet`, `Tap to dictate`, `one voice`, `Dictation · `.

---

## 4. Exact tests and commands

| Step | Command | Must show |
|---|---|---|
| 1 | `npx jest src/screens/__tests__/templateLabels.test.ts src/screens/meeting/__tests__/SummaryTab.test.tsx --forceExit --silent 2>&1 \| tail -6` | all passed |
| 1 | `cd android && ./gradlew :app:testDebugUnitTest --tests '*TemplateLabelsTest*' -q 2>&1 \| grep -E "FAILED\|BUILD\|^e: " \| head -3` | nothing |
| 2 | `npx jest src/screens/__tests__/LibraryScreen.test.tsx src/screens/__tests__/MeetingScreen.test.tsx --forceExit --silent 2>&1 \| tail -6` | all passed |
| 3 | `npx jest src/screens/__tests__/recordMode.test.ts src/pipeline/__tests__/startRecording.test.ts --forceExit --silent 2>&1 \| tail -6` | 5 passed |
| 4 | `npx jest --silent 2>&1 \| tail -6` | all suites passed |
| 5 | `npx jest src/screens/__tests__/VocabularyScreen.test.tsx --forceExit --silent 2>&1 \| tail -6` | 6 passed |
| 7 | `npx jest src/screens/__tests__/MeetingScreen.test.tsx src/screens/__tests__/ItemProvenance.test.tsx --forceExit --silent 2>&1 \| tail -6` | all passed |
| 1–7 | `npx tsc --noEmit 2>&1 \| tail -3` | nothing |
| 8 | the gate | `gate: all clear` |

---

## 5. Acceptance criteria

- All of §4 green; every test has its recorded mutant in the progress file.
- `git diff --stat 09d8037..HEAD` names only: `template_labels.json`, `templateLabels.ts`,
  `TemplateLabels.kt`, `SummaryTab.tsx`, `SummaryTab.test.tsx`, `queries.ts`, `LibraryScreen.tsx`,
  `LibraryScreen.test.tsx`, `MeetingScreen.tsx`, `MeetingScreen.test.tsx`, `recordMode.ts`,
  `recordMode.test.ts`, `recordingStore.ts`, `PipelineController.ts`, `startRecording.test.ts`,
  `RecordScreen.tsx`, `RootNavigator.tsx`, `VocabularyScreen.tsx`, `VocabularyScreen.test.tsx`,
  `SettingsScreen.tsx`, the progress file, the report.
- Copy grep: `grep -rc "Words it should write" src/screens/SettingsScreen.tsx` → 1 line;
  `grep -c "Always write “\${rule.meant}” when it hears “\${rule.heard}”?" src/screens/MeetingScreen.tsx` → 1.
- `git status` clean; two-space indentation throughout the new blocks.

---

## 6. Stop conditions

- A step needs a change under `cpp/` (beyond the golden row), in any `.kt` other than `TemplateLabels.kt`,
  in `src/components/**`, `src/native/**` or `jest.setup.js`: stop, note it in the progress file, commit,
  report.
- Two unsuccessful fixes of the same failure: stop, record both, commit, report.
- A gate stage fails in a file you did not touch: do not investigate; record 20 lines, commit, report.
- 150 steps: finish the step, commit, update the progress file, stop.

---

## 7. For the founder to test by hand (copied verbatim into the report)

1. **Record › Dictation.** Open Record. Under the status pill a switch reads *Meeting | Dictation*.
   Tap *Dictation*: the top-right label reads *Dictation · <date>*, the clock's hint reads *Tap to
   dictate* (with *· up to 15 min on Free* on a free install), and a line under the switch lists the
   five marks. Kill the app, reopen Record: *Dictation* is still selected.
2. **A dictated note.** In Dictation, tap the mic and say, with the marks spoken: *"Note for Priya
   full stop we will not ship on Monday full stop new paragraph tell finance comma the invoice is late
   question mark"*. Stop. While recording, the switch was dimmed and did not respond.
3. **What it made.** When READY: the header's date line starts *Dictation ·*; the Summary card's chip
   reads *Dictation* and does not open the type sheet when tapped; the card says *one voice*; the
   Script has no speaker names; the transcript reads *Note for Priya. We will not ship on Monday.*
   then *Tell finance, the invoice is late?* (the marks are marks, the nouns are gone). On Pro the
   Summary is the note in your words, no "The note for Priya:" label, no invented cause.
4. **The library card** for that note reads *Dictation · <date> · 1 min*.
5. **A rule from a correction (Pro).** Open any meeting's Script, long-press a line, *Correct the
   words*, change exactly one word or short phrase (e.g. a name it mis-heard), Save. A dialog asks
   *Always write “<yours>” when it hears “<its>”?* Tap *Yes*: the line is corrected, and every other
   line in this meeting with the same mis-hearing is too.
6. **Settings › Vocabulary.** Settings has a *VOCABULARY* section with *Words it should write*. It
   opens a list with the learned rule (*Learned from a correction · used N times*). *Add* asks for two
   fields; add *in over* → *Innova*. *Change* on a row edits only the second word. *Remove* asks first.
7. **Free.** With no subscription and no trial: the Settings row reads *Words it should write (Pro)*
   and opens the paywall; correcting a transcript line never asks about a rule; dictation mode still
   works (the marks apply; the note itself is Pro, as every narrative is).
8. **A rewrite is not a rule.** Correct a line by retyping it entirely: no dialog.
