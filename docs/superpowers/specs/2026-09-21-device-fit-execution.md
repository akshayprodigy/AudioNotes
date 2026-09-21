# Device fit — execution sheet (say what this phone cannot run BEFORE the download, on every screen that offers it)

*21 September 2026, against `259ab72`. One session in two runs (A = Steps 1–4, B = Steps 5–9),
~150 builder steps in all. Do not design anything: every file, function, string and test below is
decided. Execute the steps in order.*

**Why.** Three things the app knew about a phone and never said, until the person had paid, waited
or crashed:

1. **Memory.** The writer (the 1.5 B model that writes the minutes as prose) needs a phone with
   4 GB. `Narrator.capable` and `LlmModule.capable` have always gated on it — silently. Onboarding
   offers the writer's switch to every phone, the Pro screen sells "summaries written, not extracted"
   to every phone, Settings shows *Get* on a 1.1 GB download the phone will never run, the trial
   downloads it, and the Summary tab then sends a phone with no model to *Settings → Models*.
2. **Processor.** The engines are compiled for ARMv8.2 with fp16 and dot-product instructions.
   Cortex-A53 and A73 are 64-bit cores WITHOUT them — Helio G25/G35/G70/G80/G85/P60/P70, Snapdragon
   425–450/636/660: Redmi 9/9A/9C/10A, Redmi Note 7/9, Realme Narzo, tens of millions of phones.
   Play filters by ABI, not instruction set: the app installs and the first transcription dies with
   SIGILL. No test phone ever had such a core; the Galaxy Tab A does (A53+A73) and only escapes by
   running the 32-bit bench build.
3. **Disk.** A download starts without looking at free space and fails part-way with an error
   nobody can act on.

The founder's rule (21 Sep): **tell the person first, in their units, and on the Pro screen too —
and nothing device-specific: this ships.**

**What is already written (the brain's, `96d9490` + `259ab72`): `DeviceFit.kt`** — the one place
all three facts live, with their sentences composed once (like DiarBudget's skip reasons). Read it
first; **call it, never edit it.**

| Fact | Call | Sentence |
|---|---|---|
| memory | `DeviceFit.writerFits(ctx)`; `DeviceFit.unsupportedReason(ctx, spec)` → `String?` | *Writing the minutes in plain English needs a phone with 4 GB of memory; this one has 2 GB.* |
| processor | `DeviceFit.cpuFits()`; `DeviceFit.cpuReason()` → `String?` | *This phone's processor is missing instructions the speech engine needs (ARMv8.2 half-precision and dot-product), so Verbale cannot transcribe on it. Nothing has been downloaded.* |
| disk | `DeviceFit.freeBytes(ctx)`; `DeviceFit.spaceFits(need, free)`; `DeviceFit.spaceReason(what, need, free)`; `DeviceFit.DOWNLOAD_HEADROOM_BYTES` (100 MiB) | *Downloading the writer needs 1222 MB free; this phone has 800 MB free. Clear some space and try again.* |

Memory is the only PER-MODEL fact (only `llm-qwen` needs the room; the 37 MB meaning index, also
`kind == "llm"`, runs anywhere and stays offered — that is what `runnable()` below is for). The
processor and the disk are facts about the phone, read once per screen through one new native
method, `ModelManager.deviceFit()`.

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
  `## Steps` heading listing the nine steps of §2 as checkboxes, and empty *Decisions*, *Mutants*,
  *Notes* headings. Update and commit it with every step. Run B starts by reading it.
- **Hand-over at 150 steps**, whatever remains: finish the step you are on, commit, update the
  progress file, stop. Stop also when a §6 condition is met.
- **The device.** Only Step 9 touches it. The Galaxy Tab A (`R52N611D8FE`, 32-bit, 2 GB — the
  phone this whole sheet is about) is attached. Every shell that runs `adb` or `device-verify.sh`
  first runs, verbatim:
  `export ANDROID_SERIAL=R52N611D8FE ADB=~/Library/Android/sdk/platform-tools/adb DEVICE_VERIFY_GRADLE_ARGS=-PreactNativeArchitectures=armeabi-v7a`
  Never `adb uninstall`, never `pm clear`, never touch `emulator-5554` (another project's).

---

## 1. Relevant files (the only files you read)

| File | Lines | Why |
|---|---|---|
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/DeviceFit.kt` | all (142) | the fact-source — read, never edit |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/NativeBridge.kt` | 20–35 | Step 2: the engine refuses to load on a processor it would crash |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/Narrator.kt` | 1–10, 96–103 | Step 1: `capable` delegates |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/LlmModule.kt` | 1–10, 31–38 | Step 1: `capable` delegates |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ModelManagerModule.kt` | 1–20, 24–35, 60–68, 71–125 | Step 2: `list()` says it, `download()` refuses, `deviceFit()` |
| `src/native/NativeModelManager.ts` | all (15) | Step 2: one comment |
| `src/screens/downloadLabel.ts` | all (39) | Step 3: the shape of a pure screen helper to copy |
| `src/screens/__tests__/vocabularyRule.test.ts` | 1–20 | Step 3: the test conventions |
| `src/screens/OnboardingScreen.tsx` | 1–17, 34–42, 88–125, 145–166, 262–280, 340–350, 370–388, 411–428, 478–492 | Step 4 |
| `src/screens/PaywallScreen.tsx` | 51–58, 60–89, 114–120, 154–164, 183–208, 272–289, 300–308, 325–333 | Step 5 |
| `src/screens/SettingsScreen.tsx` | 58–68, 420–450, 480–545 | Step 6 |
| `src/screens/meeting/SummaryTab.tsx` | 1–16, 147–202, 366–383 | Step 7 |
| `src/screens/meeting/__tests__/SummaryTab.test.tsx` | 1–75, 255–266 | Step 7: the harness; append |
| `android/app/src/androidTest/java/com/innocorelabs/verbale/VerificationProbeTest.kt` | 1–19, 76–82 | Step 9: one line |
| `docs/superpowers/reports/2026-09-21-phase-5-vocabulary-and-dictation.md` | 1–12 | Step 9: the report's shape only |

**Must not change:** `DeviceFit.kt`, `DeviceFitTest.kt`, `ModelCatalog.kt`, `AskScreen.tsx`,
`scripts/*`, `jest.setup.js`, anything under `cpp/`, every test not named above.

---

## 2. Implementation sequence

### Run A

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

### Step 2 — the rows say it, the download refuses it, the engine will not load where it would crash

**(a) `NativeBridge.kt`**, `ensureLoaded` (20–35). Directly after `if (loaded) return` insert:

```kotlin
    // Never load engines built for instructions this processor lacks: the crash would be a SIGILL
    // in the first kernel, with no message. This is the last line of defence — onboarding says the
    // same sentence before anything is downloaded — and it protects an install that predates it.
    check(DeviceFit.cpuFits()) { DeviceFit.CPU_REASON }
```

**(b) `ModelManagerModule.kt`**, in `list()`, the row ends (lines ~63–68):

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

**(c)** Directly after `list()`'s closing brace (the line `promise.resolve(arr.toString())` then `}`),
add the new method:

```kotlin
  /**
   * The facts about the phone itself, for the screens that offer a download: whether the engines
   * can run on its processor at all (a sentence, or null) and how much disk is free. One call, so
   * onboarding and the Pro screen say the same thing DeviceFit says, before the tap.
   */
  @ReactMethod
  fun deviceFit(promise: Promise) {
    promise.resolve(
      JSONObject()
        .put("cpuReason", DeviceFit.cpuReason() ?: JSONObject.NULL)
        .put("freeBytes", DeviceFit.freeBytes(ctx))
        .toString(),
    )
  }
```

**(d)** In `download()`, directly after the `runtime_32bit` block (the line `promise.reject("runtime_32bit", …)`,
its `return`, and its closing `}`) and BEFORE the `// Checked here rather than in JS` comment, insert:

```kotlin
    // The phone before the subscription: a trial on a 2 GB phone must hear "needs 4 GB", not
    // "subscription required". Like the subscription check, these are the enforcement — the
    // screens hide the button, but a gate in the bundle is a gate anyone can edit.
    DeviceFit.cpuReason()?.let {
      promise.reject("cpu_unsupported", it)
      return
    }
    DeviceFit.unsupportedReason(ctx, spec)?.let {
      promise.reject("device_unsupported", it)
      return
    }
```

**(e)** Still in `download()`: after the `allPresent` early return (the block ending
`promise.resolve(File(modelsDir, spec.parts.first().filename).absolutePath)` / `return` / `}`) and
BEFORE `Thread {`, insert:

```kotlin
    // The disk before the network. What is still to come is every part not yet complete, less the
    // bytes a .part already holds (they are on the disk already and the resume keeps them).
    val remaining = spec.parts.sumOf { p ->
      val done = File(modelsDir, p.filename).let { it.exists() && it.length() == p.sizeBytes }
      if (done) 0L else (p.sizeBytes - File(modelsDir, p.filename + ".part").length()).coerceAtLeast(0L)
    }
    val free = DeviceFit.freeBytes(ctx)
    if (!DeviceFit.spaceFits(remaining, free)) {
      promise.reject("no_space", DeviceFit.spaceReason(spec.name, remaining, free))
      return
    }
```

(`File.length()` is 0 for a file that does not exist, so the `.part` term needs no guard.)

**(f) `src/native/NativeModelManager.ts`**: line 7's comment becomes
`list(): Promise<string>; // JSON rows: id, name, purpose, detail, kind, required, installed, needsSubscription, sizeBytes, unsupportedReason (string | null)`
and after the `list()` line add:
`deviceFit(): Promise<string>; // JSON { cpuReason: string | null, freeBytes: number } — the phone itself, before any download`

Command: `cd android && ./gradlew :app:compileDebugKotlin -q 2>&1 | grep -E "^e:" ; cd ..` → nothing.
Commit: `feat(device): rows carry unsupportedReason, deviceFit() reports the phone, download() and the engine load refuse what it cannot run`.

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

/** What ModelManager.deviceFit() returns: the phone itself, before any download. */
export type DeviceFit = { cpuReason: string | null; freeBytes: number };

/**
 * The disk rule and its sentence, mirrored from DeviceFit.kt so a screen can say it BEFORE the
 * tap (the native refusal says it again on the tap). Same headroom, same wording — the two tests
 * pin the same sentence in both languages.
 */
export const DOWNLOAD_HEADROOM_BYTES = 100 * 1024 * 1024;

export function spaceFits(needBytes: number, freeBytes: number): boolean {
  return freeBytes >= needBytes + DOWNLOAD_HEADROOM_BYTES;
}

export function spaceReason(what: string, needBytes: number, freeBytes: number): string {
  const mb = (b: number) => Math.round(b / 1e6);
  return `Downloading ${what} needs ${mb(needBytes + DOWNLOAD_HEADROOM_BYTES)} MB free; this phone has ${mb(freeBytes)} MB free. Clear some space and try again.`;
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

test('the disk sentence is the one DeviceFit.kt composes, headroom included', () => {
  const need = 1_117_320_736;
  expect(spaceFits(need, need + DOWNLOAD_HEADROOM_BYTES)).toBe(true);
  expect(spaceFits(need, need + DOWNLOAD_HEADROOM_BYTES - 1)).toBe(false);
  expect(spaceReason('the writer', need, 800_000_000)).toBe(
    'Downloading the writer needs 1222 MB free; this phone has 800 MB free. Clear some space and try again.',
  );
});
```

(the import line becomes `import { DOWNLOAD_HEADROOM_BYTES, runnable, sizeMb, spaceFits, spaceReason, writerBlockedReason } from '../deviceFit';`)

Command: `npx jest src/screens/__tests__/deviceFit.test.ts 2>&1 | grep -E "Tests:|✕"` → `Tests: 4 passed`.
Mutants, one at a time, each must print `Tests: 1 failed`: (a) in `runnable`, `!m.unsupportedReason`
→ `true`; (b) in `writerBlockedReason`, `?? null` → `?? ''`; (c) in `sizeMb`, `/ 1e6` → `/ 1e5`;
(d) in `spaceFits`, `>=` → `>`. Restore, green.
Commit: `feat(device): deviceFit.ts — the screens' reading of the rows and of the phone`.

### Step 4 — onboarding: the sentence instead of the switch

`src/screens/OnboardingScreen.tsx`.

(a) After line 12 (`import { downloadLabel, downloadPct } from './downloadLabel';`) add:
`import { runnable, sizeMb, spaceFits, spaceReason, writerBlockedReason, type DeviceFit } from './deviceFit';`

(b) `type Essential` (34–42): after `installed: boolean;` add `unsupportedReason?: string | null;`.

(c) After the `proExtras` state declaration (the line `const [proExtras, setProExtras] = useState<Essential[]>([]);`)
add:

```ts
  // The sentence this phone gets instead of the writer's switch — null on a phone that can run it.
  // Read from the catalog rows (composed natively, the memory in the GB the phone was sold as) so
  // this screen never offers a 1.1 GB download the phone cannot use. The meaning index, the other
  // `llm`-kind model, runs anywhere and stays in the plan.
  const writerBlocked = writerBlockedReason(writer);
  // The phone itself: whether the engines can run on its processor at all, and the disk that is
  // free. null until native answers; the buttons wait for it rather than offer a download that
  // would be refused on the tap.
  const [fit, setFit] = useState<DeviceFit | null>(null);
```

(c2) In the first `useEffect` (the one calling `Licence.status()` then `ModelManager.list()`), after
the `ModelManager.list()` chain's `.catch(() => {});` add:

```ts
    ModelManager.deviceFit()
      .then(r => setFit(JSON.parse(r)))
      .catch(() => setFit({ cpuReason: null, freeBytes: Number.MAX_SAFE_INTEGER }));
```

(the catch means an older native build without the method behaves exactly as before).

(d) Lines 155–166 — the three numbers — become:

```ts
  const chosen = proChosen
    ? runnable([...essentials, ...proExtras, ...(wantWriter ? writer : [])])
    : essentials;
  const pending = chosen.filter(m => !m.installed);
  const totalMb = sizeMb(pending);
  const writerMb = sizeMb(runnable(writer));
  /** What taking Pro adds over free on THIS phone, which is more than the writer on its own. */
  const proMb = sizeMb(runnable([...proExtras, ...writer]));
  // The disk sentence for THIS plan, or null. Said in place of the Download button, because a
  // button that fails on the tap with the same sentence is a worse version of the sentence.
  const pendingBytes = pending.reduce((a, m) => a + m.sizeBytes, 0);
  const spaceShort =
    fit !== null && pendingBytes > 0 && !spaceFits(pendingBytes, fit.freeBytes)
      ? spaceReason(proChosen ? 'the Pro models' : 'the speech models', pendingBytes, fit.freeBytes)
      : null;
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

(e2) The processor. Directly after the `if (status === 'done') { … }` block (line 283 onwards; it
ends with `);` and `}`, and the intro's `return (` follows), add a new early return in the shape of
the failed screen:

```tsx
  if (fit?.cpuReason) {
    return (
      <View style={[st.root, st.center, pad]}>
        <Mascot mood="asleep" size={sv(140)} />
        <Txt variant="display" style={st.mt}>
          Not this phone
        </Txt>
        <Txt variant="body" color={colors.inkSoft} style={[st.sub, st.failBody]}>
          {fit.cpuReason}
        </Txt>
      </View>
    );
  }
```

No button: there is nothing to try again and nothing to continue without. (`Mascot`'s `asleep`
mood exists — `src/components/Mascot.tsx` line 6.)

(e3) The Download button (the `<Button label={totalMb > 0 ? \`Download (${totalMb} MB)\` : 'Download'} …/>`
inside the `: (` arm after the sign-in block, ≈ line 485). Wrap it:

```tsx
        ) : spaceShort ? (
          <Txt variant="chip" color={colors.warning} style={[st.centerText, st.note]}>
            {spaceShort}
          </Txt>
        ) : (
          <Button
            label={totalMb > 0 ? `Download (${totalMb} MB)` : 'Download'}
            icon="download"
            onPress={downloadAll}
            disabled={chosen.length === 0 || fit === null}
            full
          />
        )}
```

(the existing `) : (` becomes `) : spaceShort ? (`, the new `Txt` arm goes in, then the existing
`) : (` and `Button` follow; `disabled` gains `|| fit === null`).

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

Command: `npx tsc --noEmit 2>&1 | grep -c "error" ` → `0`. Then `grep -c "writerBlocked[^R]" src/screens/OnboardingScreen.tsx` → `8` (the `[^R]` leaves out the import), and `grep -c "spaceShort\|cpuReason" src/screens/OnboardingScreen.tsx` → `7`.
Commit: `feat(device): onboarding says what this phone cannot run — the processor, the writer, the disk — before any button`.

**End of Run A.** Update the progress file, `git status` clean, stop.

### Run B

### Step 5 — the Pro screen: "Not on this phone" on the two rows it cannot keep

`src/screens/PaywallScreen.tsx`.

(a) After line 18 (`import { downloadLabel, downloadPct } from './downloadLabel';`) add:
`import { runnable, sizeMb, spaceFits, spaceReason, writerBlockedReason } from './deviceFit';`

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
  // The disk sentence for the trial's download — null when it fits, or when nothing is pending.
  const [spaceShort, setSpaceShort] = useState<string | null>(null);
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
        // Then the disk, for what the trial would still fetch. Said under the trial button; the
        // native refusal repeats it on the tap.
        const pendingBytes = writer.filter(m => !m.installed).reduce((a, m) => a + m.sizeBytes, 0);
        if (pendingBytes > 0) {
          ModelManager.deviceFit()
            .then(r => {
              const fit: { freeBytes: number } = JSON.parse(r);
              setSpaceShort(spaceFits(pendingBytes, fit.freeBytes) ? null : spaceReason('the writer', pendingBytes, fit.freeBytes));
            })
            .catch(() => {});
        }
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

(i) The trial note (the `<Txt variant="chip" color={colors.inkFaint} style={st.note}>` under the
trial button, ≈ 326–333): directly after its closing `</Txt>` add:

```tsx
                  {spaceShort ? (
                    <Txt variant="chip" color={colors.warning} style={st.note}>
                      {spaceShort}
                    </Txt>
                  ) : null}
```

Command: `npx tsc --noEmit 2>&1 | grep -c "error"` → `0`; `grep -c "writerBlocked[^R]" src/screens/PaywallScreen.tsx` → `4`; `grep -c "spaceShort" src/screens/PaywallScreen.tsx` → `4`.
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

### Step 8 — the Ask screen and the meeting say the same processor sentence

Nothing to do: `AskScreen` refuses through `Llm.ask` (`NOT_CAPABLE`) and the meeting fails through
`NativeBridge.ensureLoaded`'s `check` from Step 2(a) — its message reaches the meeting's failure
reason unchanged. Record in the progress file that this step was verified by reading, not by code:
`grep -n "check(DeviceFit.cpuFits())" android/app/src/main/java/com/innocorelabs/verbale/pipeline/NativeBridge.kt`
→ one line. No commit.

### Step 9 — the probe, the device, the gate, the report

(a) `VerificationProbeTest.kt`: after `import com.innocorelabs.verbale.data.AudioDb` add
`import com.innocorelabs.verbale.data.ModelCatalog` and `import com.innocorelabs.verbale.pipeline.DeviceFit`.
After the line `println("PROBE vocabulary (${vocab.length()}): $vocab")` add:

```kotlin
    // Device fit: what every screen is told about this phone before any download.
    val total = DeviceFit.totalBytes(ctx)
    println("PROBE device: total=$total marketed=${DeviceFit.marketedGb(total)} GB writerFits=${DeviceFit.writerFits(total)} " +
      "cpuFits=${DeviceFit.cpuFits()} free=${DeviceFit.freeBytes(ctx)} " +
      "reason=${DeviceFit.unsupportedReason(ctx, ModelCatalog.byId("llm-qwen")!!)}")
```

(b) Device run (the `export` line first, in this shell):
`scripts/device-verify.sh VerificationProbeTest 2>&1 | grep -E "^==>|OK \(|FAILURES|passed|FAILED"` → `OK (1 test)`, `passed`.
Then `$ADB logcat -d | grep "PROBE device" | tail -1` → must print
`PROBE device: total=1862561792 marketed=2 GB writerFits=false cpuFits=true free=<n> reason=Writing the minutes in plain English needs a phone with 4 GB of memory; this one has 2 GB.`
(`total=` is the kernel's MemTotal in bytes — 1 818 908 kB on this tablet; within 1 % of that is the same reading. `cpuFits=true` because the bench build is 32-bit — its A53+A73 cores would read `false` under a 64-bit build, which is the point of the check. `free=` is whatever the disk has. Everything else verbatim.) Copy the line into the report.

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
- `ModelManager.deviceFit()`: JSON `{ cpuReason: string | null, freeBytes: number }`.
- `ModelManager.download(id)` rejects `cpu_unsupported`, then `device_unsupported`, before the subscription
  check; `no_space` after the already-present check and before any network.
- `NativeBridge.ensureLoaded` throws `IllegalStateException(DeviceFit.CPU_REASON)` on a processor the engines cannot run on.
- `src/screens/deviceFit.ts`: `writerBlockedReason(rows)`, `runnable(rows)`, `sizeMb(rows)`, `spaceFits(need, free)`,
  `spaceReason(what, need, free)`, `DOWNLOAD_HEADROOM_BYTES`, `type DeviceFit`.
- `Narrator.capable(ctx)` and `Llm.capable()` unchanged in signature and result; both read `DeviceFit`.
- No new settings keys, routes, props or native modules.

## 4. Exact tests and commands

| Step | Command | Must print |
|---|---|---|
| 1, 2 | `cd android && ./gradlew :app:compileDebugKotlin -q 2>&1 \| grep -E "^e:"; cd ..` | nothing |
| 3 | `npx jest src/screens/__tests__/deviceFit.test.ts 2>&1 \| grep -E "Tests:"` | `Tests: 4 passed` (each of 4 mutants: `1 failed`) |
| 4–7 | `npx tsc --noEmit 2>&1 \| grep -c "error"` | `0` |
| 7 | `npx jest src/screens/meeting/__tests__/SummaryTab.test.tsx 2>&1 \| grep -E "Tests:"` | all passed, count +2 (mutant: `1 failed`) |
| 9 | `scripts/device-verify.sh VerificationProbeTest …` + logcat | the `PROBE device:` line in §2 Step 9(b) |
| 9 | `scripts/gate.sh 2>&1 \| grep -E "^\s+(ok\|FAIL)\|gate:"` | seven `ok`, `gate: all clear` |

## 5. Acceptance criteria

- `git diff --stat 259ab72..HEAD` names only: `Narrator.kt`, `LlmModule.kt`, `ModelManagerModule.kt`,
  `NativeBridge.kt`, `NativeModelManager.ts`, `deviceFit.ts` (new), `deviceFit.test.ts` (new), `OnboardingScreen.tsx`,
  `PaywallScreen.tsx`, `SettingsScreen.tsx`, `SummaryTab.tsx`, `SummaryTab.test.tsx`,
  `VerificationProbeTest.kt`, the report, and the progress file's creation and removal.
- `grep -rn "3L \* 1024 \* 1024 \* 1024" android/app/src/main` → prints nothing (the gate lives in DeviceFit only).
- `grep -c "unsupportedReason" src/screens/OnboardingScreen.tsx src/screens/PaywallScreen.tsx src/screens/SettingsScreen.tsx` → `1`, `2`, `5`.
- The `PROBE device:` line from the tablet, verbatim, in the report's §6.
- `grep -rn "/proc/cpuinfo\|usableSpace" android/app/src/main/java/com/innocorelabs/verbale/pipeline/ModelManagerModule.kt` → nothing (both facts come through DeviceFit).
- The 32-bit release APK reinstalled on the tablet (Step 9c) — the founder's by-hand run of both this
  and Phase 5 happens on it.

## 6. Stop conditions

- A step needs an API, prop, colour or import outside what this sheet names → stop, record it.
- Two failed fixes of one failing test or compile error → stop, record it.
- A failure in a file this sheet does not touch → do not investigate; record and stop.
- The tablet is absent at Step 9 → do (a), (d), (e) with §6 of the report saying "not run", stop.
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
6. **The disk sentence** (any phone): fill the phone until under ~300 MB is free (a few large videos
   in the camera app), open Settings › On-device models, remove *Writes down what was said, more
   accurately* (Whisper small), tap *Get* on it: the alert reads *Could not download* — *Downloading
   Whisper small needs 295 MB free; this phone has N MB free. Clear some space and try again.* — and
   nothing was fetched. Delete the videos.
7. **The processor sentence** cannot be shown on the tablet (its 32-bit build passes by design) or on
   any v8.2 phone. It is proved by `DeviceFitTest` against the real feature lines of A53, A73 and
   A76 cores; the first Helio G80/G85 or Snapdragon 636/660 phone we borrow shows *Not this phone* on
   onboarding with the sentence, and nothing downloads.
