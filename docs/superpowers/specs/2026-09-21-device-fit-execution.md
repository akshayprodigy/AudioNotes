# Device fit — execution sheet (say it before the download: what this phone cannot run, on every screen that offers it)

*21 September 2026, against `96d9490`. One session, eight steps, ~110 builder steps. Do not design
anything: every file, function, string and test below is decided. Execute the steps in order.*

**Why.** The writer (the 1.5 B model that writes the minutes as prose) needs a phone with 4 GB of
memory. The app has always known this — `Narrator.capable` and `LlmModule.capable` gate on it — and
has never said it: onboarding offers the writer's switch to every phone, the Pro screen sells
"summaries written, not extracted" to every phone, Settings shows *Get* on a 1.1 GB download the
phone will never run, the trial downloads it, and the meeting then says nothing until the Summary
tab — where a phone with no model is even sent to *Settings → Models* to fetch it. The founder's
rule (21 Sep): **tell the person first, and tell them on the Pro screen too.**

**What is already written (the brain's, `96d9490`): `DeviceFit.kt`** — the one place the fact lives.
`DeviceFit.writerFits(ctx)` is the unchanged 3 GiB gate; `DeviceFit.unsupportedReason(ctx, spec)`
is the sentence a screen prints verbatim, or null: *"Writing the minutes in plain English needs a
phone with 4 GB of memory; this one has 2 GB."* — the memory in the GB the phone was sold as
(`marketedGb` = ceil of the kernel's total; the Galaxy Tab A's 1.73 GiB reads as 2 GB; a phone sold
as 3 GB reports ~2.8 GiB and has never cleared the gate, hence 4). Its JVM test and two mutants are
done. **Call it, never edit it.** Only `llm-qwen` needs the room; the 37 MB meaning index
(`embed-bge-small`, also `kind == "llm"`) runs anywhere and stays offered — that is what
`runnable()` below is for.

---

## 0. Rules

- **Token discipline.** Read only the files and line ranges in §1. Never print a file over 200 lines;
  `grep -n` then `sed -n 'A,Bp'` at most 60 lines at a time. `OnboardingScreen.tsx` is 551 lines,
  `PaywallScreen.tsx` 508, `SettingsScreen.tsx` ~1,100, `SummaryTab.tsx` ~560: only the ranges
  named. Every command below ends in its filter — run it exactly. Do not re-read a file after
  editing it. Do not paste code into your messages; commit it.
- **TDD + mutant** where a step names a test: test first, see it fail, code, see it pass, apply the
  named mutant, see the test fail, restore, green. Record each mutant in the progress file's
  *Mutants* as it happens. Steps with no test are checked by `npx tsc --noEmit` or the Kotlin compile.
- **Commit after each step**, subject in the house style (`git log --oneline -6`). Never push. Never
  run `connectedDebugAndroidTest`. **`git status` must be clean before you stop.** **Indent like the
  surrounding file: two spaces, TypeScript and Kotlin alike; JSX attributes one per line when the tag
  wraps, as the neighbours do.**
- **Progress file.** First action: create `docs/superpowers/reports/device-fit-progress.md` with a
  `## Steps` heading listing the eight steps of §2 as checkboxes, and empty *Decisions*, *Mutants*,
  *Notes* headings. Update and commit it with every step.
- **Hand-over at 150 steps**, whatever remains: finish the step you are on, commit, update the
  progress file, stop. Stop also when a §6 condition is met.
- **The device.** Only Step 8 touches it. The Galaxy Tab A (`R52N611D8FE`, 32-bit, 2 GB — the
  phone this whole sheet is about) is attached. Every shell that runs `adb` or `device-verify.sh`
  first runs, verbatim:
  `export ANDROID_SERIAL=R52N611D8FE ADB=~/Library/Android/sdk/platform-tools/adb DEVICE_VERIFY_GRADLE_ARGS=-PreactNativeArchitectures=armeabi-v7a`
  Never `adb uninstall`, never `pm clear`, never touch `emulator-5554` (another project's).

---

## 1. Relevant files (the only files you read)

| File | Lines | Why |
|---|---|---|
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/DeviceFit.kt` | all (63) | the fact-source — read, never edit |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/Narrator.kt` | 1–10, 96–103 | Step 1: `capable` delegates |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/LlmModule.kt` | 1–10, 31–38 | Step 1: `capable` delegates |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ModelManagerModule.kt` | 1–20, 24–35, 60–68, 71–90 | Step 2: `list()` says it, `download()` refuses |
| `src/native/NativeModelManager.ts` | all (15) | Step 2: one comment |
| `src/screens/downloadLabel.ts` | all (39) | Step 3: the shape of a pure screen helper to copy |
| `src/screens/__tests__/vocabularyRule.test.ts` | 1–20 | Step 3: the test conventions |
| `src/screens/OnboardingScreen.tsx` | 1–17, 34–42, 88–107, 145–166, 370–388, 411–428 | Step 4 |
| `src/screens/PaywallScreen.tsx` | 51–58, 60–89, 114–120, 154–164, 183–208, 272–289, 300–308, 325–333 | Step 5 |
| `src/screens/SettingsScreen.tsx` | 58–68, 420–450, 480–545 | Step 6 |
| `src/screens/meeting/SummaryTab.tsx` | 1–16, 147–202, 366–383 | Step 7 |
| `src/screens/meeting/__tests__/SummaryTab.test.tsx` | 1–75, 255–266 | Step 7: the harness; append |
| `android/app/src/androidTest/java/com/innocorelabs/verbale/VerificationProbeTest.kt` | 1–19, 76–82 | Step 8: one line |
| `docs/superpowers/reports/2026-09-21-phase-5-vocabulary-and-dictation.md` | 1–12 | Step 8: the report's shape only |

**Must not change:** `DeviceFit.kt`, `DeviceFitTest.kt`, `ModelCatalog.kt`, `AskScreen.tsx`,
`scripts/*`, `jest.setup.js`, anything under `cpp/`, every test not named above.

---

## 2. Implementation sequence

### Step 1 — the two gates read the one fact

`Narrator.kt` 96–103 currently reads:

```kotlin
  /** Rough device gate: enough RAM to run a ~1.5B Q4 model without thrashing. Matches LlmModule. */
  fun capable(ctx: Context): Boolean {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
    return mem.totalMem >= 3L * 1024 * 1024 * 1024
  }
```

Replace those six lines with:

```kotlin
  /** The device gate, from the one place that also tells the person about it (DeviceFit). */
  fun capable(ctx: Context): Boolean = DeviceFit.writerFits(ctx)
```

Delete `import android.app.ActivityManager` (line 3) — it was the only use. Run
`grep -n "ActivityManager" android/app/src/main/java/com/innocorelabs/verbale/pipeline/Narrator.kt`
→ must print nothing.

`LlmModule.kt` 31–38 currently reads:

```kotlin
  /** Rough device gate: enough RAM to run a ~1.5B Q4 model without thrashing. */
  @ReactMethod
  fun capable(promise: Promise) {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
    val enoughRam = mem.totalMem >= 3L * 1024 * 1024 * 1024 // >= 3 GB total
    promise.resolve(enoughRam)
  }
```

Replace with:

```kotlin
  /** The device gate, from the one place that also tells the person about it (DeviceFit). */
  @ReactMethod
  fun capable(promise: Promise) {
    promise.resolve(DeviceFit.writerFits(ctx))
  }
```

Delete `import android.app.ActivityManager` (line 3). Check `Context` is still used in the file:
`grep -c "Context\." android/app/src/main/java/com/innocorelabs/verbale/pipeline/LlmModule.kt` — if it
prints `0`, delete `import android.content.Context` too; if it prints ≥ 1, keep it.

Command: `cd android && ./gradlew :app:compileDebugKotlin -q 2>&1 | grep -E "^e:" ; cd ..` → must print nothing. Commit: `refactor(device): Narrator and LlmModule read the gate from DeviceFit`.

### Step 2 — the catalog rows say it, and the download refuses it

`ModelManagerModule.kt`, in `list()`, the row ends (lines ~63–68):

```kotlin
          // So the UI can say "Pro" against it rather than offering a download that will be
          // refused. The refusal in download() is the enforcement; this is only the honesty.
          .put("needsSubscription", ModelCatalog.needsSubscription(spec))
          .put("sizeBytes", spec.sizeBytes),
```

Insert between the `needsSubscription` line and the `sizeBytes` line:

```kotlin
          // Why THIS phone cannot run it, as the sentence every screen prints — or null. The
          // screens used to offer the writer to every phone and let the Summary tab break the
          // news after a 1.1 GB download; now the row carries the answer before the button.
          .put("unsupportedReason", DeviceFit.unsupportedReason(ctx, spec) ?: JSONObject.NULL)
```

In `download()`, directly after the `runtime_32bit` block (the line `promise.reject("runtime_32bit", …)`,
its `return`, and its closing `}`) and BEFORE the `// Checked here rather than in JS` comment, insert:

```kotlin
    // The phone before the subscription: a trial on a 2 GB phone must hear "needs 4 GB", not
    // "subscription required". Like the subscription check, this is the enforcement — the screens
    // hide the button, but a gate in the bundle is a gate anyone can edit.
    DeviceFit.unsupportedReason(ctx, spec)?.let {
      promise.reject("device_unsupported", it)
      return
    }
```

`src/native/NativeModelManager.ts` line 7: change the comment to
`list(): Promise<string>; // JSON rows: id, name, purpose, detail, kind, required, installed, needsSubscription, sizeBytes, unsupportedReason (string | null)`.

Command: `cd android && ./gradlew :app:compileDebugKotlin -q 2>&1 | grep -E "^e:" ; cd ..` → nothing.
Commit: `feat(device): model rows carry unsupportedReason; download() refuses what the phone cannot run`.

### Step 3 — the pure helper the screens share

Create `src/screens/deviceFit.ts`:

```ts
/**
 * What ModelManager.list() says about THIS phone, read by every screen that offers the writer.
 *
 * `unsupportedReason` is composed natively (DeviceFit.kt): one sentence, the phone's memory in the
 * GB it was sold as, null for every model this phone can run. These helpers exist so no screen
 * re-derives "can the writer run here" from `kind` — which is how the writer came to be offered,
 * sold and downloaded on phones that could not run it. The meaning index shares the writer's
 * `kind` and runs anywhere; `runnable` keeps it and drops the writer alone.
 */
export type FitRow = { kind: string; unsupportedReason?: string | null };

/** The sentence to print instead of the writer's switch, button or promise — null when it runs here. */
export function writerBlockedReason(models: FitRow[]): string | null {
  const blocked = models.find(m => m.kind === 'llm' && m.unsupportedReason);
  return blocked?.unsupportedReason ?? null;
}

/** The part of a wanted set this phone can actually run: what a download plan may contain. */
export function runnable<T extends FitRow>(models: T[]): T[] {
  return models.filter(m => !m.unsupportedReason);
}

/** Megabytes, rounded, as the screens quote a download. */
export function sizeMb(models: { sizeBytes: number }[]): number {
  return Math.round(models.reduce((a, m) => a + m.sizeBytes, 0) / 1e6);
}
```

Create `src/screens/__tests__/deviceFit.test.ts`:

```ts
import { runnable, sizeMb, writerBlockedReason } from '../deviceFit';

const REASON =
  'Writing the minutes in plain English needs a phone with 4 GB of memory; this one has 2 GB.';
const writer = { id: 'llm-qwen', kind: 'llm', installed: false, sizeBytes: 1_117_320_736, unsupportedReason: REASON };
const embed = { id: 'embed-bge-small', kind: 'llm', installed: false, sizeBytes: 36_806_944, unsupportedReason: null };
const small = { id: 'whisper-small', kind: 'asr', installed: false, sizeBytes: 190_000_000, unsupportedReason: null };
const okWriter = { ...writer, unsupportedReason: null };

test('the reason is the writer sentence, and only when the writer is blocked', () => {
  expect(writerBlockedReason([writer, embed, small])).toBe(REASON);
  expect(writerBlockedReason([okWriter, embed, small])).toBeNull();
  expect(writerBlockedReason([])).toBeNull();
  // A row without the field (an older native build) is not blocked.
  expect(writerBlockedReason([{ kind: 'llm' }])).toBeNull();
});

test('runnable drops exactly the blocked model and keeps the meaning index', () => {
  expect(runnable([writer, embed, small]).map(m => m.id)).toEqual(['embed-bge-small', 'whisper-small']);
  expect(runnable([okWriter, embed]).map(m => m.id)).toEqual(['llm-qwen', 'embed-bge-small']);
});

test('sizeMb rounds the sum to whole megabytes', () => {
  expect(sizeMb([writer, embed])).toBe(1154);
  expect(sizeMb([])).toBe(0);
});
```

Command: `npx jest src/screens/__tests__/deviceFit.test.ts 2>&1 | grep -E "Tests:|✕"` → `Tests: 3 passed`.
Mutants, one at a time, each must print `Tests: 1 failed`: (a) in `runnable`, `!m.unsupportedReason`
→ `true`; (b) in `writerBlockedReason`, `?? null` → `?? ''`; (c) in `sizeMb`, `/ 1e6` → `/ 1e5`.
Restore, green. Commit: `feat(device): deviceFit — the screens' reading of unsupportedReason`.

### Step 4 — onboarding: the sentence instead of the switch

`src/screens/OnboardingScreen.tsx`.

(a) After line 12 (`import { downloadLabel, downloadPct } from './downloadLabel';`) add:
`import { runnable, sizeMb, writerBlockedReason } from './deviceFit';`

(b) `type Essential` (34–42): after `installed: boolean;` add `unsupportedReason?: string | null;`.

(c) After the `proExtras` state declaration (the line `const [proExtras, setProExtras] = useState<Essential[]>([]);`)
add:

```ts
  // The sentence this phone gets instead of the writer's switch — null on a phone that can run it.
  // Read from the catalog rows (composed natively, the memory in the GB the phone was sold as) so
  // this screen never offers a 1.1 GB download the phone cannot use. The meaning index, the other
  // `llm`-kind model, runs anywhere and stays in the plan.
  const writerBlocked = writerBlockedReason(writer);
```

(d) Lines 155–166 — the three numbers — become:

```ts
  const chosen = proChosen
    ? runnable([...essentials, ...proExtras, ...(wantWriter ? writer : [])])
    : essentials;
  const totalMb = sizeMb(chosen.filter(m => !m.installed));
  const writerMb = sizeMb(runnable(writer));
  /** What taking Pro adds over free on THIS phone, which is more than the writer on its own. */
  const proMb = sizeMb(runnable([...proExtras, ...writer]));
```

(replacing the `const chosen … ;`, `const totalMb = Math.round(…);`, `const writerMb = …;`, the
`/** What taking Pro adds … */` comment and `const proMb = Math.round(…);` — five statements, nothing
else; the `proChosen` line above them stays).

(e) The note under the two tier buttons (the `<Txt variant="chip" color={colors.inkFaint} style={[st.centerText, st.note]}>`
whose text begins `Free records, transcribes`) — replace its contents (the text between the opening
and closing `Txt` tags) with:

```tsx
            {writerBlocked
              ? `Free records, transcribes and pulls out the decisions and actions — no account, for as long as you use it. Pro transcribes with a larger model and searches by meaning, and downloads ${proMb} MB more. ${writerBlocked}`
              : `Free records, transcribes and pulls out the decisions and actions — no account, for as long as you use it. Pro writes the minutes as prose, transcribes with a larger model, and downloads ${proMb} MB more.`}
```

(f) The writer card (411–428). The icon well and icon:

```tsx
              <View style={[st.bulletIcon, { backgroundColor: writerBlocked ? colors.warningSoft : colors.primarySoft }]}>
                <Icon name="edit" size={s(20)} color={writerBlocked ? colors.warning : colors.primary} strokeWidth={2.4} />
              </View>
```

The body `Txt`'s expression becomes a three-way:

```tsx
                  {writerBlocked
                    ? `${writerBlocked} The minutes here are pulled out by rule, and everything else in Pro works on this phone.`
                    : proChosen
                      ? `Adds ${writerMb} MB. Without it you still get minutes, pulled out by rule rather than written as prose.`
                      : `Part of the subscription — a ${writerMb} MB model that runs on your phone. You still get minutes without it, pulled out by rule rather than written as prose.`}
```

The switch line becomes:

```tsx
              {proChosen && !writerBlocked ? <Switch on={wantWriter} onToggle={() => setWantWriter(v => !v)} /> : null}
```

and the comment above it gains one sentence: `No switch either when the phone cannot run the model — the sentence is the whole card.`

Command: `npx tsc --noEmit 2>&1 | grep -c "error" ` → `0`. Then `grep -c "writerBlocked[^R]" src/screens/OnboardingScreen.tsx` → `8` (the `[^R]` leaves out the import).
Commit: `feat(device): onboarding says what this phone cannot run instead of offering the switch`.

### Step 5 — the Pro screen: "Not on this phone" on the two rows it cannot keep

`src/screens/PaywallScreen.tsx`.

(a) After line 18 (`import { downloadLabel, downloadPct } from './downloadLabel';`) add:
`import { runnable, sizeMb, writerBlockedReason } from './deviceFit';`

(b) The rules comment (51–58): after the line ending `There is no roadmap on this page.` add a third
bullet, indented as the others:
` *   - Nothing is promised to a phone that cannot keep the promise. The two rows the writer`
` *     delivers say "Not on this phone" — with the memory it needs and has — on a phone under`
` *     the gate, before the trial or the price.`

(c) `INCLUDED`'s type gets `needsWriter?: boolean`:
`const INCLUDED: { icon: IconName; title: string; body: string; needsWriter?: boolean }[] = [`
and the two rows titled `'Summaries written, not extracted'` and `'Minutes that read like minutes'`
each gain `needsWriter: true,` as their last property.

(d) State (after `const [writerInstalled, setWriterInstalled] = useState(false);`):

```ts
  // The sentence for a phone under the writer's gate — null when it runs here. From the rows.
  const [writerBlocked, setWriterBlocked] = useState<string | null>(null);
```

(e) The list effect (154–164) — the `.then` body becomes:

```ts
        const all: { id: string; kind: string; sizeBytes: number; installed: boolean; unsupportedReason?: string | null }[] =
          JSON.parse(r);
        // The writer's set on THIS phone: the meaning index everywhere, the model itself only
        // where it fits. What the trial downloads and what the note prices are the same set.
        const writer = runnable(all.filter(m => m.kind === 'llm'));
        setWriterBlocked(writerBlockedReason(all));
        setWriterMb(sizeMb(writer));
        setWriterInstalled(writer.length > 0 && writer.every(m => m.installed));
```

(f) In `onStartTrial`, the `list` type gains `unsupportedReason?: string | null` and the `missing` line becomes:
`const missing = runnable(list).filter(m => m.kind === 'llm' && !m.installed);`

(g) The `INCLUDED.map` render (272–288) becomes:

```tsx
          {INCLUDED.map((f, i) => {
            const off = f.needsWriter === true && writerBlocked !== null;
            return (
              <Pop key={f.title} index={i + 2}>
                <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
                  <View style={st.feature}>
                    <View style={[st.featureIcon, { backgroundColor: off ? colors.warningSoft : colors.primarySoft }]}>
                      <Icon name={f.icon} size={s(20)} color={off ? colors.warning : colors.primary} strokeWidth={2.4} />
                    </View>
                    <View style={st.flex}>
                      <Txt variant="cardTitleSm">{f.title}</Txt>
                      <Txt variant="chip" color={colors.inkSoft} style={st.featureBody}>
                        {f.body}
                      </Txt>
                      {off ? (
                        <Txt variant="chip" color={colors.warning} style={st.featureBody}>
                          Not on this phone. {writerBlocked}
                        </Txt>
                      ) : null}
                    </View>
                  </View>
                </Raised>
              </Pop>
            );
          })}
```

(h) The download line (≈305): `Downloading the writer — {…}` becomes
`Downloading the {writerBlocked ? 'meaning index' : 'writer'} — {downloadLabel(dl.downloaded, dl.total)}`.

Command: `npx tsc --noEmit 2>&1 | grep -c "error"` → `0`; `grep -c "writerBlocked[^R]" src/screens/PaywallScreen.tsx` → `4`.
Commit: `feat(device): the Pro screen says "Not on this phone" on the rows the writer delivers`.

### Step 6 — Settings: the sentence instead of Get

`src/screens/SettingsScreen.tsx`.

(a) `type Model` (58–68): after `needsSubscription: boolean;` add `unsupportedReason?: string | null;`.

(b) `onToggle` (420–450): directly after the `if (m.installed) { … return; }` block insert:

```ts
    if (m.unsupportedReason) {
      // No button reaches here — the row shows the sentence instead of Get — but the download is
      // refused natively for the same reason, and a refusal should read the same as the row.
      Alert.alert('Not on this phone', m.unsupportedReason);
      return;
    }
```

(c) In the row render, after `const busy = progress[m.id] !== undefined && !m.installed;` add:
```ts
            // Present on disk is still theirs to remove; what the phone cannot run is not offered.
            const off = !m.installed && !!m.unsupportedReason;
```

(d) The detail line `{m.detail}` becomes `{off ? m.unsupportedReason : m.detail}`.

(e) The `Pressable` pill: wrap it — `{off ? null : (` … `)}` around the whole `<Pressable … </Pressable>`,
re-indented two spaces deeper as the neighbours would be.

(f) The tag: its `backgroundColor` expression becomes
`off ? colors.warningSoft : m.needsSubscription ? colors.successSoft : m.required ? colors.primarySoft : colors.cardAlt`,
its `color` becomes `off ? colors.warning : m.needsSubscription ? colors.success : m.required ? colors.primary : colors.inkFaint`,
and its text becomes `{off ? 'NOT ON THIS PHONE' : m.needsSubscription ? 'PRO' : m.required ? 'REQUIRED' : 'OPTIONAL'}`
— keep the existing multi-line layout of those two ternaries, adding the `off ?` arm as the first line of each.

Command: `npx tsc --noEmit 2>&1 | grep -c "error"` → `0`; `grep -c "unsupportedReason" src/screens/SettingsScreen.tsx` → `5`.
Commit: `feat(device): Settings shows NOT ON THIS PHONE and the sentence instead of Get`.

### Step 7 — the Summary tab: the phone before the model

`src/screens/meeting/__tests__/SummaryTab.test.tsx` — append at the end of the file:

```tsx
describe('why there is no summary', () => {
  test('a phone under the gate hears the memory sentence, not "Settings → Models"', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    (Llm.available as jest.Mock).mockResolvedValue(false);
    (Llm.capable as jest.Mock).mockResolvedValue(false);
    (ModelManager.list as jest.Mock).mockResolvedValueOnce(
      JSON.stringify([
        { id: 'llm-qwen', kind: 'llm', installed: false, sizeBytes: 1, unsupportedReason: 'needs a phone with 4 GB of memory; this one has 2 GB.' },
      ]),
    );
    const tree = await renderTab({ minutes: [] });
    const texts = tree.root
      .findAll(n => typeof n.props.children === 'string')
      .map(n => n.props.children as string);
    expect(texts.some(t => t.includes('this one has 2 GB'))).toBe(true);
    expect(texts.some(t => t.includes('Settings → Models'))).toBe(false);
  });

  test('a capable phone with no model is sent to Settings', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    (Llm.available as jest.Mock).mockResolvedValue(false);
    (Llm.capable as jest.Mock).mockResolvedValue(true);
    const tree = await renderTab({ minutes: [] });
    const texts = tree.root
      .findAll(n => typeof n.props.children === 'string')
      .map(n => n.props.children as string);
    expect(texts.some(t => t.includes('Settings → Models'))).toBe(true);
  });
});
```

and add two imports after line 30 (`import { entitlement } from '../../../billing/trial';`):
```ts
import Llm from '../../../native/NativeLlm';
import ModelManager from '../../../native/NativeModelManager';
```
(`ModelManager` resolves to the global mock in `jest.setup.js`; `Llm` to this file's.)

Run: `npx jest src/screens/meeting/__tests__/SummaryTab.test.tsx 2>&1 | grep -E "Tests:|✕"` → the first
new test fails (it prints `Settings → Models`), the second passes.

`src/screens/meeting/SummaryTab.tsx`:

(a) After line 10 (`import Llm from '../../native/NativeLlm';`) add
`import ModelManager from '../../native/NativeModelManager';` and after line 15 add
`import { writerBlockedReason } from '../deviceFit';`.

(b) After `const [lapsedCopy, setLapsedCopy] = React.useState('');` add:
```ts
  // The sentence for a phone under the writer's gate, from the catalog rows — the same one
  // onboarding and Settings show, with the memory it needs and has.
  const [weakCopy, setWeakCopy] = React.useState(
    'This phone does not have enough memory to write the summary on-device.',
  );
```

(c) The two lines

```ts
        const [available, capable] = await Promise.all([Llm.available(), Llm.capable()]);
        if (!alive) return;
        setReason(!available ? 'no-model' : !capable ? 'weak-device' : 'not-run');
```

become:

```ts
        const [available, capable, rows] = await Promise.all([
          Llm.available(),
          Llm.capable(),
          ModelManager.list().catch(() => '[]'),
        ]);
        if (!alive) return;
        const blocked = writerBlockedReason(JSON.parse(rows));
        if (blocked) setWeakCopy(blocked);
        // The phone before the model. This used to be the other way round, which sent a phone
        // under the gate to Settings to fetch 1.1 GB it could never run.
        setReason(!capable ? 'weak-device' : !available ? 'no-model' : 'not-run');
```

(d) In the copy block (≈379–380), `'This phone does not have enough memory to write the summary on-device.'`
becomes `weakCopy`.

Run the same jest command → `Tests: N passed` with both new tests. Mutant: in (c) swap the order back
to `!available ? 'no-model' : !capable ? 'weak-device'` → the first new test fails. Restore, green.
`npx tsc --noEmit 2>&1 | grep -c "error"` → `0`.
Commit: `fix(device): the Summary tab blames the phone before the missing model`.

### Step 8 — the probe, the device, the gate, the report

(a) `VerificationProbeTest.kt`: after `import com.innocorelabs.verbale.data.AudioDb` add
`import com.innocorelabs.verbale.data.ModelCatalog` and `import com.innocorelabs.verbale.pipeline.DeviceFit`.
After the line `println("PROBE vocabulary (${vocab.length()}): $vocab")` add:

```kotlin
    // Device fit: what every screen is told about this phone before any download.
    val total = DeviceFit.totalBytes(ctx)
    println("PROBE device: total=$total marketed=${DeviceFit.marketedGb(total)} GB writerFits=${DeviceFit.writerFits(total)} " +
      "reason=${DeviceFit.unsupportedReason(ctx, ModelCatalog.byId("llm-qwen")!!)}")
```

(b) Device run (the `export` line first, in this shell):
`scripts/device-verify.sh VerificationProbeTest 2>&1 | grep -E "^==>|OK \(|FAILURES|passed|FAILED"` → `OK (1 test)`, `passed`.
Then `$ADB logcat -d | grep "PROBE device" | tail -1` → must print
`PROBE device: total=1862561792 marketed=2 GB writerFits=false reason=Writing the minutes in plain English needs a phone with 4 GB of memory; this one has 2 GB.`
(`total=` is the kernel's MemTotal in bytes — 1 818 908 kB on this tablet; within 1 % of that is the same reading. Everything after it verbatim.) Copy the line into the report.

(c) Rebuild and reinstall the release build for the founder (device-verify left the debug one):
`cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=armeabi-v7a -q 2>&1 | grep -E "^e:|FAIL"; cd ..`
→ nothing; then `$ADB install -r android/app/build/outputs/apk/release/app-release.apk 2>&1 | tail -1` → `Success`.

(d) The gate: `scripts/gate.sh 2>&1 | grep -E "^\s+(ok|FAIL)|gate:"` → every stage `ok`, `gate: all clear`.
(Its device stage skips itself while the emulator is attached — say so in the report; (b) is the device evidence.)

(e) Write `docs/superpowers/reports/2026-09-21-device-fit.md` with the sections of the Phase 5 report
(1 status, 2 what was built, 3 decisions, 4 tests — a table with each test, result and mutant, 5 gate,
6 device — the PROBE line verbatim, 7 for the founder to test by hand — copy §7 of this sheet
verbatim, 8 known gaps, 9 commits). Then `git rm docs/superpowers/reports/device-fit-progress.md`.
Commit: `docs(device): device-fit report; progress file retired`. `git status` → clean. Stop.

---

## 3. Expected interfaces after this session

- `ModelManager.list()` rows: `+ unsupportedReason: string | null` (the sentence, or null).
- `ModelManager.download(id)` rejects `device_unsupported` with the sentence, before the subscription check.
- `src/screens/deviceFit.ts`: `writerBlockedReason(rows): string | null`, `runnable(rows)`, `sizeMb(rows)`.
- `Narrator.capable(ctx)` and `Llm.capable()` unchanged in signature and result; both read `DeviceFit`.
- No new settings keys, routes, props or native modules.

## 4. Exact tests and commands

| Step | Command | Must print |
|---|---|---|
| 1, 2 | `cd android && ./gradlew :app:compileDebugKotlin -q 2>&1 \| grep -E "^e:"; cd ..` | nothing |
| 3 | `npx jest src/screens/__tests__/deviceFit.test.ts 2>&1 \| grep -E "Tests:"` | `Tests: 3 passed` (each of 3 mutants: `1 failed`) |
| 4–7 | `npx tsc --noEmit 2>&1 \| grep -c "error"` | `0` |
| 7 | `npx jest src/screens/meeting/__tests__/SummaryTab.test.tsx 2>&1 \| grep -E "Tests:"` | all passed, count +2 (mutant: `1 failed`) |
| 8 | `scripts/device-verify.sh VerificationProbeTest …` + logcat | the `PROBE device:` line in §2 Step 8(b), verbatim |
| 8 | `scripts/gate.sh 2>&1 \| grep -E "^\s+(ok\|FAIL)\|gate:"` | seven `ok`, `gate: all clear` |

## 5. Acceptance criteria

- `git diff --stat 96d9490..HEAD` names only: `Narrator.kt`, `LlmModule.kt`, `ModelManagerModule.kt`,
  `NativeModelManager.ts`, `deviceFit.ts` (new), `deviceFit.test.ts` (new), `OnboardingScreen.tsx`,
  `PaywallScreen.tsx`, `SettingsScreen.tsx`, `SummaryTab.tsx`, `SummaryTab.test.tsx`,
  `VerificationProbeTest.kt`, the report, and the progress file's creation and removal.
- `grep -rn "3L \* 1024 \* 1024 \* 1024" android/app/src/main` → prints nothing (the gate lives in DeviceFit only).
- `grep -c "unsupportedReason" src/screens/OnboardingScreen.tsx src/screens/PaywallScreen.tsx src/screens/SettingsScreen.tsx` → `1`, `2`, `5`.
- The `PROBE device:` line from the tablet, verbatim, in the report's §6.
- The 32-bit release APK reinstalled on the tablet (Step 8c) — the founder's by-hand run of both this
  and Phase 5 happens on it.

## 6. Stop conditions

- A step needs an API, prop, colour or import outside what this sheet names → stop, record it.
- Two failed fixes of one failing test or compile error → stop, record it.
- A failure in a file this sheet does not touch → do not investigate; record and stop.
- The tablet is absent at Step 8 → do (a), (d), (e) with §6 of the report saying "not run", stop.
- 150 steps → commit, progress file, stop.

## 7. For the founder to test by hand (copied verbatim into the report; on the Galaxy Tab A, 2 GB)

1. **Onboarding.** Under *Try Pro free for 7 days* the note ends *…downloads 227 MB more. Writing
   the minutes in plain English needs a phone with 4 GB of memory; this one has 2 GB.* The *Write the
   minutes in plain English* card has an amber icon, reads that sentence followed by *The minutes here
   are pulled out by rule, and everything else in Pro works on this phone.*, and has **no switch**.
   Tap *Try Pro free for 7 days*: the button reads *Download (227 MB)* — the larger transcriber and
   the meaning index; never 1300-odd. Take it (Wi-Fi).
2. **Settings › On-device models.** *Writes the minutes in plain English* shows the tag **NOT ON THIS
   PHONE**, the sentence in place of its description, and no *Get*. *Finds what was meant…* (the
   meaning index) shows *PRO* and is installed. Every other row is as before.
3. **The Pro screen** (Settings › the subscription row, or the paywall from a meeting): *Summaries
   written, not extracted* and *Minutes that read like minutes* carry an amber icon and a second line
   *Not on this phone. Writing the minutes … this one has 2 GB.*; *Search everything…* and *The larger
   transcriber* do not.
4. **A meeting.** Record two minutes of speech and let it finish. Summary tab: the card says
   *Writing the minutes in plain English needs a phone with 4 GB of memory; this one has 2 GB.* — not
   *Settings → Models*, and no *Write it again*.
5. **Nothing was downloaded that cannot run:** Settings › Storage (or the models list) shows no
   1.1 GB writer; the tablet's free space did not drop by a gigabyte.
