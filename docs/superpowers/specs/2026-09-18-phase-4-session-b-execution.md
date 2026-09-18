# Phase 4 — Session B execution sheet (screens, device, report)

*18 September 2026. For the session that builds Session B. Do not design anything: every file,
function, prop, string and test below is decided. Execute the steps in order. The brief
(`docs/superpowers/specs/2026-09-17-phase-4-remembered-voices-brief.md`) is the reference for
the copy (§2.9) and the report contract (§7); read only those two sections of it. Session A is
done and reviewed (`9750864`); its progress file is
`docs/superpowers/reports/phase-4-progress.md` — read it, then keep it updated after every commit.*

---

## 0. Rules (unchanged from the brief, compressed)

- **Token discipline.** Read only the files and line ranges in §1. Never print a file over 200
  lines; `grep -n` then `sed -n 'A,Bp'` at most 60 lines at a time. Every command below already
  ends in its filter — run it exactly. Do not re-read a file after editing it. Do not paste code
  into your messages; commit it.
- **TDD + mutant.** For each step: write the test, run it, see it fail; write the code; run it,
  see it pass; apply the named mutant, see the test fail; restore; run green. Record the mutant
  line in the progress file's *Mutants* heading before moving on.
- **Commit after each step** with a one-line subject in the house style (`git log --oneline -6`).
  Never push. Never run `connectedDebugAndroidTest`.
- **Progress file.** After each commit: tick the step in `docs/superpowers/reports/phase-4-progress.md`,
  add the mutant line. If context is two thirds used: commit, update the file, stop.
- **Phone.** `export ANDROID_SERIAL=36091FDH30034G`. Before any screen action:
  `adb shell dumpsys window | grep mCurrentFocus`. If Verbale is not focused and you did not put
  another app there — wait, then report; never push through.

---

## 1. Relevant files (the only files you read)

| File | Lines to read | Why |
|---|---|---|
| `docs/superpowers/reports/phase-4-progress.md` | all | where Session A stopped |
| `docs/superpowers/specs/2026-09-17-phase-4-remembered-voices-brief.md` | §2.9 (grep `Copy, verbatim`), §7 (grep `## 7`) | the copy; the report shape |
| `src/db/queries.ts` | 205–215 (`speakers:`), 480–500 (Session A's `rememberVoice`/`answerSuggestion`/`forgetVoices`) | the query to extend; the wrappers you call |
| `src/pipeline/types.ts` | 76–82 (`interface Speaker`) | the type to extend |
| `src/screens/SpeakersScreen.tsx` | 1–60, 85–147, 148–190 | the screen you change most |
| `src/screens/meeting/SummaryTab.tsx` | 50–66, 104–112, 156–160, 215–241, 370–386, 505–530 | props, `paid`, the review banner (copy its shape), the thread line, styles |
| `src/screens/MeetingScreen.tsx` | 88–92, 122–126, 258–280, 300–312, 1170–1190 | state, the Phase 3 thread wiring (copy its shape), the SummaryTab JSX |
| `src/screens/SettingsScreen.tsx` | 1–30 (imports), 120–128, 278–284, 326–340, 742–790 | where to mount the Voices section, how a setting is read, a Switch row |
| `src/components/ui.tsx` | 262–275 (`SoftButton`), 633–640 (`Switch`), 701–706 (`SectionRule`) | signatures |
| `src/screens/meeting/__tests__/SummaryTab.test.tsx` | 1–75, 148–200 | the render helper and the thread-line tests (copy their shape) |
| `src/screens/__tests__/MeetingScreen.test.tsx` | 1–60, 280–312 | the render helper and the thread test (copy its shape) |
| `src/screens/__tests__/LibraryScreen.test.tsx` | 1–60 | the nav/route mocks for a screen test |
| `docs/superpowers/reports/2026-09-17-phase-3-thread-memory.md` | §7 only | a by-hand section done right |

**Files that must not change:** anything under `android/`, `cpp/`, `scripts/`; `src/db/schema.ts`; `jest.setup.js` (Session A already
added the three stubs); `src/native/*`; `src/navigation/RootNavigator.tsx` (no new route — the
`Speakers` route exists); every screen not named in §2.

---

## 2. Implementation sequence

### Step 7 — the query, the type, the copy helper

**7a.** `src/pipeline/types.ts`: replace the `Speaker` interface with

```ts
export interface Speaker {
  id: string;
  meetingId: string;
  clusterLabel: string;
  displayName: string;
  /** Phase 4: the `people.id` a voice match proposes, or null. */
  suggestedPerson: string | null;
  /** Phase 4: that person's name, joined in the query, or null. */
  suggestedName: string | null;
}
```

**7b.** `src/db/queries.ts`, `speakers:` — replace the SQL with

```ts
  speakers: (meetingId: string) =>
    run<Speaker>(
      'SELECT s.id, s.meeting_id AS meetingId, s.cluster_label AS clusterLabel, ' +
        's.display_name AS displayName, s.suggested_person AS suggestedPerson, ' +
        'p.name AS suggestedName ' +
        'FROM speakers s LEFT JOIN people p ON p.id = s.suggested_person ' +
        'WHERE s.meeting_id = ?',
      [meetingId],
    ),
```

**7c.** Create `src/screens/voiceCopy.ts`:

```ts
/**
 * The Summary tab's voice banner (Phase 4). Names in speaker order; three or more collapse to
 * "and N more". Pure, so the wording is pinned by voiceCopy.test.ts and nowhere else.
 */
export function soundsLike(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `Sounds like ${names[0]} — confirm?`;
  if (names.length === 2) return `Sounds like ${names[0]} and ${names[1]} — confirm?`;
  const more = names.length - 2;
  return `Sounds like ${names[0]}, ${names[1]} and ${more} more — confirm?`;
}
```

**7d.** Create `src/screens/__tests__/voiceCopy.test.ts` — five cases: `[]` → `''`; `['Priya']`;
`['Priya','Ravi']`; `['Priya','Ravi','Sam']` → `'Sounds like Priya, Ravi and 1 more — confirm?'`;
five names → `'… and 3 more — confirm?'`. Run:
`npx jest src/screens/__tests__/voiceCopy.test.ts --forceExit --silent 2>&1 | tail -6`.
*Mutant:* return `${names.length - 1} more` → the three- and five-name cases fail.

**7e.** `npx tsc --noEmit 2>&1 | tail -5` must be empty. Every test that builds a `Speaker`
literal now needs the two new fields — `npx tsc` tells you which files; add
`suggestedPerson: null, suggestedName: null` to each literal and nothing else.

Commit: `feat(voices): the speakers query joins the suggested person; soundsLike copy`.

### Step 8 — SpeakersScreen: the suggestion line, Yes/No, the rename hook, the one-time card

**8a.** Imports in `src/screens/SpeakersScreen.tsx`: add `Alert` to the `react-native` import;
add `SoftButton` to the `../components/ui` import; add
`import { entitlement } from '../billing/trial';`.

**8b.** State and helpers, after `const [busy, setBusy] = useState(false);`:

```tsx
  const [paid, setPaid] = useState(false);
  useEffect(() => {
    let alive = true;
    entitlement().then(e => { if (alive) setPaid(e.paid); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const DEFAULT_NAME = /^Speaker \d+$/;

  /**
   * The one-time card (brief §2.7): paid, a real name, the setting never set, never asked before.
   * Resolves once the person has answered; "Turn on" also remembers this speaker straight away.
   */
  const maybeOfferToRemember = async (speakerId: string, name: string) => {
    if (!paid) return;
    const [remember, prompted] = await Promise.all([
      db.getSetting('voices_remember'),
      db.getSetting('voices_prompted'),
    ]);
    if (remember !== null || prompted === '1') return;
    Alert.alert(
      'Remember this voice?',
      'Verbale can keep a voiceprint of each speaker you name — on this phone only, never uploaded — and suggest the name from your next meeting. Voiceprints are personal, sometimes biometric, data: tell the people you record where the law requires it. You can forget all voices any time in Settings.',
      [
        { text: 'Not now', style: 'cancel', onPress: () => { db.setSetting('voices_prompted', '1').catch(() => {}); } },
        {
          text: 'Turn on',
          onPress: async () => {
            await db.setSetting('voices_remember', '1');
            await db.setSetting('voices_prompted', '1');
            await db.rememberVoice(speakerId, name).catch(() => {});
          },
        },
      ],
    );
  };

  const rename = async (speakerId: string, name: string) => {
    await db.renameSpeaker(speakerId, name);
    const clean = name.trim();
    if (clean === '' || DEFAULT_NAME.test(clean)) return;
    await db.rememberVoice(speakerId, clean).catch(() => {});
    await maybeOfferToRemember(speakerId, clean);
  };

  const answer = async (speakerId: string, accept: boolean) => {
    await db.answerSuggestion(speakerId, accept);
    load();
  };
```

**8c.** The row. Replace the `TextInput`'s `onEndEditing` with
`onEndEditing={e => rename(item.id, e.nativeEvent.text)}`. Then, the row is a horizontal `View`
(`st.row`); the suggestion line must sit UNDER the input, so wrap: change

```tsx
                <View style={st.row}>
                  <View style={[st.avatar, …]}> … </View>
                  <TextInput … />
                  {isTarget ? ( … ) : ( … )}
                </View>
```

into

```tsx
                <View>
                  <View style={st.row}>
                    …the three children exactly as they are…
                  </View>
                  {item.suggestedName ? (
                    <View style={st.suggest}>
                      <Txt variant="chip" color={colors.inkSoft} style={st.flex}>
                        Sounds like {item.suggestedName}?
                      </Txt>
                      <SoftButton
                        icon="check"
                        label="Yes"
                        onPress={() => answer(item.id, true)}
                        accessibilityLabel={`Yes, this is ${item.suggestedName}`}
                      />
                      <SoftButton
                        icon="x"
                        label="No"
                        onPress={() => answer(item.id, false)}
                        accessibilityLabel={`No, not ${item.suggestedName}`}
                      />
                    </View>
                  ) : null}
                </View>
```

`SoftButton` takes `label`, `icon`, `onPress` and no `accessibilityLabel` — so wrap each button
in `<View accessibilityLabel={…}>` and put the label on that `View`; do not edit `ui.tsx`. The
icon names `check` and `x` exist in `IconName`.

Styles, in `makeStyles`: add
`suggest: { flexDirection: 'row', alignItems: 'center', gap: s(8), paddingHorizontal: s(14), paddingBottom: s(12) },`
and `flex: { flex: 1, flexShrink: 1 },`. The two buttons keep `flexShrink: 0` (SoftButton's own
style; if the label clips on the phone, wrap the button in `<View style={{ flexShrink: 0 }}>`).

**8d.** Create `src/screens/__tests__/SpeakersScreen.test.tsx`. Mocks at the top, exactly the
LibraryScreen.test shape: `jest.mock('../../db/queries')`, the `react-native-safe-area-context`
mock, `jest.mock('../../pipeline/PipelineController', () => ({ PipelineController: { regenerateMinutes: jest.fn() } }))`,
`jest.mock('../../billing/trial', () => ({ entitlement: jest.fn() }))`. Nav and route:
`const nav = { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as never;`
`const route = { key: 'sp', name: 'Speakers', params: { meetingId: 'm1' } } as never;`
Fixture speakers: `s1` = `{ id: 's1', meetingId: 'm1', clusterLabel: 'S0', displayName: 'Speaker 1', suggestedPerson: 'p1', suggestedName: 'Priya' }`,
`s2` = same shape, `displayName: 'Speaker 2'`, both suggestion fields `null`.
`beforeEach`: `jest.clearAllMocks(); (db.speakers as jest.Mock).mockResolvedValue([s1, s2]); (db.getSetting as jest.Mock).mockResolvedValue(null); (db.setSetting as jest.Mock).mockResolvedValue(undefined); (db.renameSpeaker as jest.Mock).mockResolvedValue(undefined); (db.rememberVoice as jest.Mock).mockResolvedValue({ remembered: true }); (db.answerSuggestion as jest.Mock).mockResolvedValue({ name: 'Priya' }); (entitlement as jest.Mock).mockResolvedValue({ paid: true }); jest.spyOn(Alert, 'alert').mockImplementation(() => {});`
Render with `renderer.create(<SpeakersScreen navigation={nav} route={route} />)` inside `act`.

Tests (each `test(...)`):
1. **a suggested speaker shows the line and both buttons** — find `Txt` whose children join to
   `'Sounds like Priya?'`; `findByProps({ accessibilityLabel: 'Yes, this is Priya' })` and
   `'No, not Priya'` exist; for `s2` no `Txt` contains `'Sounds like'`.
2. **Yes answers true and reloads** — press Yes (`props.onPress()` inside `act`); expect
   `db.answerSuggestion` called with `('s1', true)` and `db.speakers` called twice (load + reload).
3. **No answers false** — expect `('s1', false)`.
4. **a rename writes the name then remembers it** — call the `TextInput`'s `onEndEditing({ nativeEvent: { text: 'Priya' } })`
   for `s2` inside `act`; expect `db.renameSpeaker('s2', 'Priya')` then `db.rememberVoice('s2', 'Priya')`;
   with text `'Speaker 9'` `rememberVoice` is NOT called; with `'   '` not called.
5. **the one-time card appears once and "Turn on" writes both keys** — paid, `getSetting` → null
   for both keys: after the rename, `Alert.alert` called once; take
   `(Alert.alert as jest.Mock).mock.calls[0][2]` (the buttons), find the one with `text === 'Turn on'`,
   `await act(async () => button.onPress())`; expect `db.setSetting('voices_remember','1')`,
   `db.setSetting('voices_prompted','1')`, and `db.rememberVoice('s2','Priya')` called twice in
   total (once from `rename`, once from Turn on).
6. **"Not now" writes only voices_prompted** — same, press `'Not now'`; `setSetting` called once
   with `('voices_prompted','1')`.
7. **no card when already prompted** — `getSetting` resolves `'1'` for `voices_prompted`
   (`mockImplementation(async k => (k === 'voices_prompted' ? '1' : null))`); `Alert.alert` not
   called.
8. **no card when the setting is already set** — `voices_remember` resolves `'0'`; not called.
9. **no card on free** — `entitlement` → `{ paid: false }`; not called; `rememberVoice` still
   called (the native side answers `not_pro`; the screen does not pre-judge).

Run: `npx jest src/screens/__tests__/SpeakersScreen.test.tsx --forceExit --silent 2>&1 | tail -12`.
*Mutants (do each, record each):* swap `true`/`false` in the two buttons → tests 2–3 fail;
delete the `rememberVoice` call in `rename` → 4 fails; delete the `if (!paid) return;` → 9 fails;
`prompted === '1'` changed to `=== '0'` → 7 fails.

Commit: `feat(voices): SpeakersScreen — "Sounds like Priya?", Yes/No, remember on rename, the one-time card`.

### Step 9 — the Summary banner and the MeetingScreen wiring

**9a.** `src/screens/meeting/SummaryTab.tsx`: two new props after `onOpenThread` in both the
destructuring and the type:

```tsx
  /** Phase 4: the names voice matching proposes for this meeting's speakers, in speaker order. Paid only. */
  voiceSuggestions?: string[];
  onConfirmVoices?: () => void;
```

Import: `import { soundsLike } from '../voiceCopy';`. JSX — directly ABOVE the review banner
(`{needsLook > 0 && onReview ? (`), the same `Raised` shape:

```tsx
      {paid && voiceSuggestions && voiceSuggestions.length > 0 && onConfirmVoices ? (
        <View style={st.reviewWrap}>
          <Raised edge={colors.primary} fill={colors.primarySoft} rad={radius.card} depth={4}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Confirm voices"
              onPress={onConfirmVoices}
              style={st.reviewBanner}>
              <Icon name="users" size={s(20)} color={colors.primary} strokeWidth={2.4} />
              <View style={st.flex}>
                <Txt variant="bodyBlack">{soundsLike(voiceSuggestions)}</Txt>
                <Txt variant="chipSoft" color={colors.inkSoft}>
                  One tap names them on the Speakers screen.
                </Txt>
              </View>
              <Txt variant="chip" color={colors.primary}>
                Speakers
              </Txt>
            </Pressable>
          </Raised>
        </View>
      ) : null}
```

`colors.primarySoft` exists in the palette. No new styles.

**9b.** `src/screens/meeting/__tests__/SummaryTab.test.tsx`: add `voiceSuggestions: [] as string[]`
and `onConfirmVoices: jest.fn()` to `baseProps`. New `describe('the voice banner')` with four
tests in the thread-line tests' shape (lines 148–200):
1. paid + `['Priya']` → `findByProps({ accessibilityLabel: 'Confirm voices' })` exists and its
   `Txt` with variant `bodyBlack` reads `'Sounds like Priya — confirm?'`; pressing calls
   `onConfirmVoices`.
2. paid + `['Priya','Ravi','Sam']` → reads `'Sounds like Priya, Ravi and 1 more — confirm?'`.
3. free + `['Priya']` → no element with that label.
4. paid + `[]` → none.
*Mutants:* drop `paid &&` → 3 fails; pass `voiceSuggestions.slice(1)` to `soundsLike` → 1 fails.

**9c.** `src/screens/MeetingScreen.tsx`: after the `threads` state (line ~124) nothing new is
needed — derive from `speakers`: add, next to the other `useMemo`s (grep `useMemo(` for the
nearest one and place it after it),

```tsx
  const voiceSuggestions = useMemo(
    () => speakers.map(sp => sp.suggestedName).filter((n): n is string => !!n),
    [speakers],
  );
```

and in the `<SummaryTab … />` JSX after `onOpenThread={…}`:

```tsx
                voiceSuggestions={voiceSuggestions}
                onConfirmVoices={() => navigation.navigate('Speakers', { meetingId })}
```

**9d.** `src/screens/__tests__/MeetingScreen.test.tsx`: in the thread `describe` (or a sibling),
one test: `(db.speakers as jest.Mock).mockResolvedValue([ {…s1 with suggestedName 'Priya'}, {…s2 with suggestedName 'Ravi'}, {…s3 with null} ])`
(use the full `Speaker` shape); render; `summaryTab.props.voiceSuggestions` equals `['Priya','Ravi']`;
`summaryTab.props.onConfirmVoices()` → `nav.navigate('Speakers', { meetingId: 'm1' })` (use the
file's own meeting id and nav mock). *Mutant:* `filter` dropped → `['Priya','Ravi',null]`, fails.

Run both: `npx jest src/screens/meeting/__tests__/SummaryTab.test.tsx src/screens/__tests__/MeetingScreen.test.tsx --forceExit --silent 2>&1 | tail -12`.

Commit: `feat(voices): the Summary tab's "Sounds like …" banner, from the speakers MeetingScreen already loads`.

### Step 10 — the Voices section in Settings, as its own component

**10a.** Create `src/screens/settings/VoicesSection.tsx` (new folder):

```tsx
import React from 'react';
import { Alert, View, StyleSheet } from 'react-native';
import Icon from '../../components/Icon';
import { Raised, SectionRule, SoftButton, Switch, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';

/**
 * Settings › Voices (Phase 4). Pure: reads its state from props, reports changes up. Paid shows
 * the switch; free shows "(Pro)" and the row opens the paywall. "Forget all voices" is shown to
 * both — a lapsed user can still delete. Copy is the brief's §2.9, verbatim.
 */
export default function VoicesSection({
  paid,
  remember,
  onToggle,
  onForget,
  onUpgrade,
}: {
  paid: boolean;
  remember: boolean;
  onToggle: (next: boolean) => void;
  onForget: () => void;
  onUpgrade: () => void;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const confirmForget = () =>
    Alert.alert(
      'Forget all voices?',
      'This deletes every stored voiceprint on this phone. Names already given to speakers stay.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Forget', style: 'destructive', onPress: onForget },
      ],
    );
  return (
    <>
      <View style={st.ruleWrap}>
        <SectionRule label="VOICES" />
      </View>
      <View style={st.list}>
        <Raised
          edge={colors.line}
          fill={colors.card}
          rad={radius.xl}
          depth={5}
          onPress={paid ? undefined : onUpgrade}>
          <View style={st.rowPad}>
            <View style={st.row}>
              <Icon name="users" size={s(18)} color={colors.inkSoft} strokeWidth={2.4} />
              <View style={st.flex}>
                <Txt variant="bodyStrong">{paid ? 'Remember voices' : 'Remember voices (Pro)'}</Txt>
                <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                  When you name a speaker, Verbale keeps a small numeric voiceprint of that voice on
                  this phone and uses it to suggest the name next time. Nothing is uploaded and
                  nothing leaves the phone. A voiceprint is personal data — in some places biometric
                  data — so turn this on only if you are comfortable holding it, and tell the people
                  you record where the law or your workplace requires it. "Forget all voices" deletes
                  every voiceprint at any time.
                </Txt>
              </View>
              {paid ? <Switch on={remember} onToggle={() => onToggle(!remember)} /> : null}
            </View>
            <View style={st.forget}>
              <SoftButton icon="trash" label="Forget all voices" onPress={confirmForget} />
            </View>
          </View>
        </Raised>
      </View>
    </>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    ruleWrap: { marginTop: s(22), marginBottom: s(10), paddingHorizontal: s(20) },
    list: { paddingHorizontal: s(20), gap: s(10) },
    rowPad: { padding: s(14), gap: s(12) },
    row: { flexDirection: 'row', alignItems: 'center', gap: s(12) },
    flex: { flex: 1, gap: s(4) },
    tiny: { lineHeight: s(17) },
    forget: { alignItems: 'flex-start' },
    _unused: { color: c.ink },
  });
}
```

`SectionRule` is exported from `ui.tsx` and the icon `trash` exists. Match
`ruleWrap`/`list`/`rowPad`/`row` values to SettingsScreen's own `makeStyles` (grep those four
names there and copy their values) so the section lines up with its neighbours; then delete the
`_unused` entry and the `c` parameter's use if nothing else reads it.

**10b.** `src/screens/SettingsScreen.tsx`: import `VoicesSection from './settings/VoicesSection'`
and `{ entitlement } from '../billing/trial'` (if not already imported — grep). State next to
`announceOn`:

```tsx
  const [voicesRemember, setVoicesRemember] = useState<boolean | null>(null);
  const [voicesPaid, setVoicesPaid] = useState(false);
```

In the `useEffect` that reads `announceRecording` (line ~333), add:

```tsx
    db.getSetting('voices_remember')
      .then(v => setVoicesRemember(v === '1'))
      .catch(() => setVoicesRemember(false));
    entitlement().then(e => setVoicesPaid(e.paid)).catch(() => {});
```

JSX: directly AFTER the "BEFORE YOU RECORD" `st.list` `View` closes (the one holding the
Announce card and the Consent-card row; find its closing `</View>` by matching indentation),
insert:

```tsx
        {voicesRemember === null ? null : (
          <VoicesSection
            paid={voicesPaid}
            remember={voicesRemember}
            onToggle={next => {
              setVoicesRemember(next);
              db.setSetting('voices_remember', next ? '1' : '0').catch(() => {});
            }}
            onForget={() => {
              db.forgetVoices().catch(() => {});
            }}
            onUpgrade={() => navigation.navigate('Paywall')}
          />
        )}
```

**10c.** Create `src/screens/__tests__/VoicesSection.test.tsx` (renders the component alone —
no db, no navigation): `jest.spyOn(Alert, 'alert')` in `beforeEach`. Tests:
1. paid → `Txt` reads `'Remember voices'`; a `Switch` (import it from `../../components/ui` and
   `findByType`) exists with `on` equal to the `remember` prop; calling its `onToggle()` calls
   `onToggle(true)` when `remember` was false.
2. free → reads `'Remember voices (Pro)'`; no `Switch`; the `Raised`'s `onPress` is `onUpgrade`
   (find by type `Raised`, call `props.onPress()`, expect `onUpgrade` called).
3. the explanation paragraph is present verbatim (assert on a `Txt` whose joined children contain
   `'Nothing is uploaded and nothing leaves the phone.'`).
4. Forget: press the `SoftButton` labelled `'Forget all voices'`; `Alert.alert` called with title
   `'Forget all voices?'`; the `'Forget'` button's `onPress()` calls `onForget`; `'Cancel'` does not.
Run: `npx jest src/screens/__tests__/VoicesSection.test.tsx --forceExit --silent 2>&1 | tail -10`.
*Mutants:* `paid ?` inverted → 1 and 2 fail; Forget's `onPress` removed → 4 fails.

**10d.** `npx tsc --noEmit 2>&1 | tail -5` empty; `npx eslint src/screens/settings/VoicesSection.tsx src/screens/SettingsScreen.tsx src/screens/SpeakersScreen.tsx src/screens/meeting/SummaryTab.tsx 2>&1 | tail -10` clean.

Commit: `feat(voices): Settings › Voices — the switch, the consent text, forget all`.

### Step 11 — the gate, then the phone

**11a.** `GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh > /tmp/gate.log 2>&1; grep -E "^==>|ok |FAIL|all clear|Tests:" /tmp/gate.log`
→ must end `gate: all clear`. If a stage fails, fix only what the failure names (see §5).

**11b.** Phone attached? `adb devices | grep -c 36091FDH30034G` must print `1`; else skip to
step 12 and say so in the report. Then:
`scripts/device-verify.sh PeopleDbTest > /tmp/dv.log 2>&1; grep -E "^==>|OK \(|FAILURES|test=|Failure" /tmp/dv.log | tail -12`
and `scripts/device-verify.sh NativePipelineTest > /tmp/dv2.log 2>&1; grep -E "OK \(|FAILURES|Failure" /tmp/dv2.log | tail -5`.
Expected: `OK (3 tests)` and `OK (17 tests)`.

Commit anything that moved (usually nothing): `chore(voices): gate and device green after the screens`.

### Step 12 — by hand on the phone, then the report

Only with the phone attached and Verbale focused (`adb shell dumpsys window | grep mCurrentFocus`).
Metro first: `npx react-native start > /tmp/metro.log 2>&1 &` then `adb reverse tcp:8081 tcp:8081`.
Trial: `adb shell am instrument -w -r -e class com.innocorelabs.verbale.VerificationTrialTest com.innocorelabs.verbale.test/androidx.test.runner.AndroidJUnitRunner 2>&1 | grep -E "OK|FAIL"`.
Record through the Mac's speaker with `say -v Samantha "<text>"` while the app records (the
Pixel's mic hears the Mac at normal volume from ~30 cm). Read results with
`adb shell am instrument -w -r -e class com.innocorelabs.verbale.VerificationProbeTest … 2>&1 | grep PROBE | tail -30`
instead of screenshots wherever the probe answers the question.

1. Settings → Voices → turn *Remember voices* on. Probe: nothing yet. Note what the screen says.
2. Record meeting 1: forty seconds of `say -v Samantha` (any text, e.g. three sentences repeated).
   Wait for processing (probe shows `status=done`). Speakers screen → rename "Speaker 1" to
   **Sam**. Probe: `people count 1`, that speaker `has_voice=1`. The one-time card must NOT
   appear (the setting is on already) — note it.
3. Record meeting 2: forty seconds, same Samantha voice. After processing: probe shows the new
   meeting's speaker `suggested_person` set; the Summary tab shows *Sounds like Sam — confirm?*;
   Speakers screen shows *Sounds like Sam?* → tap **Yes** → the row reads "Sam"; probe: `samples=2`.
4. Record meeting 3: forty seconds of `say -v Daniel`. After processing: no suggestion (probe
   `suggested_person` null; no banner).
5. The one-time card: Settings → turn *Remember voices* off. Then reset the flags:
   `adb shell am instrument -w -r -e class com.innocorelabs.verbale.VerificationVoicesTest#resetTheVoicePrompt com.innocorelabs.verbale.test/androidx.test.runner.AndroidJUnitRunner 2>&1 | grep -E "OK|FAIL"`.
   Open meeting 3's Speakers screen and rename "Speaker 1" to **Dan** → the card *Remember this
   voice?* appears (note its title, body and the two buttons) → tap *Turn on*. Probe: the
   settings now hold `voices_remember=1` and `voices_prompted=1` (extend the probe's SELECT if it
   does not print settings — it is a verification tool). Rename another speaker → no card.
6. Settings → *Forget all voices* → *Forget*. Probe: `people count 0`, every `has_voice=0`.
   Record meeting 4 with Samantha → no suggestion.
7. End the trial:
   `adb shell am instrument -w -r -e class com.innocorelabs.verbale.VerificationVoicesTest#endTheTrial com.innocorelabs.verbale.test/androidx.test.runner.AndroidJUnitRunner 2>&1 | grep -E "OK|FAIL"`
   (if it FAILS with "still entitled", a licence token is present — say so and skip). Reopen
   Settings: the row reads "Remember voices (Pro)", no switch; tapping it opens the paywall;
   *Forget all voices* is still there. Then start the trial again (`VerificationTrialTest`).

Then write `docs/superpowers/reports/2026-09-18-phase-4-remembered-voices.md` with the nine
sections of the brief's §7, the mutants copied from the progress file, and §7's "For the founder"
steps written from what you actually saw. Update `docs/superpowers/plans/2026-09-17-release-phases.md`
(Phase 4 → "Done 18 Sep", Phase 5 → "Next"), add the scorecard row
(`docs/superpowers/specs/2026-09-15-improvement-report-scorecard.md`: "Persistent voice profiles"
→ ✅ 18 Sep), delete `docs/superpowers/reports/phase-4-progress.md`, commit:
`docs: Phase 4 report — remembered voices done`. Stop.

---

## 3. Expected interfaces (what exists after each step — do not deviate)

```ts
// types.ts
interface Speaker { id; meetingId; clusterLabel; displayName; suggestedPerson: string | null; suggestedName: string | null }

// queries.ts (Session A, already present — call, do not edit)
db.rememberVoice(speakerId: string, name: string): Promise<{ remembered: boolean; reason?: string }>
db.answerSuggestion(speakerId: string, accept: boolean): Promise<{ name: string }>
db.forgetVoices(): Promise<void>
db.getSetting(key: string): Promise<string | null>
db.setSetting(key: string, value: string): Promise<void>

// voiceCopy.ts
soundsLike(names: string[]): string

// SummaryTab props (new)
voiceSuggestions?: string[]; onConfirmVoices?: () => void

// VoicesSection props
{ paid: boolean; remember: boolean; onToggle: (next: boolean) => void; onForget: () => void; onUpgrade: () => void }
```

Settings keys: `voices_remember` (`'1'` on, `'0'` off, null never set), `voices_prompted` (`'1'`).

---

## 4. Exact tests and commands

| Step | Command | Must show |
|---|---|---|
| 7 | `npx jest src/screens/__tests__/voiceCopy.test.ts --forceExit --silent 2>&1 \| tail -6` | `Tests: 5 passed` |
| 7 | `npx tsc --noEmit 2>&1 \| tail -5` | nothing |
| 8 | `npx jest src/screens/__tests__/SpeakersScreen.test.tsx --forceExit --silent 2>&1 \| tail -12` | `Tests: 9 passed` |
| 9 | `npx jest src/screens/meeting/__tests__/SummaryTab.test.tsx src/screens/__tests__/MeetingScreen.test.tsx --forceExit --silent 2>&1 \| tail -12` | all passed, 5 new |
| 10 | `npx jest src/screens/__tests__/VoicesSection.test.tsx --forceExit --silent 2>&1 \| tail -10` | `Tests: 4 passed` |
| 10 | `npx eslint <the four files> 2>&1 \| tail -10` | nothing |
| 11 | the gate line above | `gate: all clear` |
| 11 | the two device-verify lines above | `OK (3 tests)`, `OK (17 tests)` |

---

## 5. Acceptance criteria

- All of §4 green; every test in §2 has its recorded mutant in the progress file.
- No file outside §2's list changed (`git diff --stat 9750864..HEAD` names only: `types.ts`,
  `queries.ts`, `voiceCopy.ts` + test, `SpeakersScreen.tsx` + test, `SummaryTab.tsx` + test,
  `MeetingScreen.tsx` + test, `SettingsScreen.tsx`, `settings/VoicesSection.tsx` + test, the
  `Speaker`-literal fixups tsc demanded, the progress file, the report, the plan, the scorecard).
- Copy matches the brief's §2.9 character for character (`grep -c "Nothing is uploaded and nothing leaves the phone." src/screens/settings/VoicesSection.tsx` prints 1).
- The report exists with all nine sections and says plainly which by-hand items did not run.

---

## 6. Stop conditions

- If any step needs a change under `android/`, `cpp/`, `src/db/schema.ts`, `jest.setup.js` or
  `src/components/ui.tsx`: stop, write what and why in the progress file under *Notes*, commit,
  report. (Session A owns those; the founder decides.)
- After two unsuccessful fixes of the same failing test or the same compile error: stop, record
  the error text and both attempts in the progress file, commit, report.
- If a gate stage fails in a file this session did not touch: do not investigate; record the
  stage's last 20 lines in the progress file, commit, report.
- If the phone is absent or in someone else's use: do steps 7–11a, write the report with §6/§7
  marked "not run — phone unavailable", commit, report. Never wait more than ten minutes for the
  phone.
- If context reaches two thirds: finish the current step, commit, update the progress file, stop.
