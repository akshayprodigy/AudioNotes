# Device fit — execution report

## 1. Status

Complete: all nine steps of `docs/superpowers/specs/2026-09-21-device-fit-execution.md` built,
tested, mutation-tested where the sheet named a test, and committed to `main`; the gate is clear;
nothing pushed. Run A (Steps 1–4) and Run B (Steps 5–9) executed as two sessions, per the sheet.

## 2. What was built

- **`Narrator.capable` / `LlmModule.capable`** (Step 1) delegate to `DeviceFit.writerFits(ctx)`
  instead of each carrying its own copy of the 3 GiB gate.
- **`ModelManagerModule`** (Step 2): `list()` rows carry `unsupportedReason` (the sentence, or
  null); a new `deviceFit()` method reports `{ cpuReason, freeBytes }`; `download()` refuses
  `cpu_unsupported`, then `device_unsupported`, before the subscription check, and `no_space`
  before starting the network transfer. `NativeBridge.ensureLoaded` refuses to load the engines
  on a processor missing the ARMv8.2 fp16/dot-product instructions.
- **`src/screens/deviceFit.ts`** (Step 3): the pure helpers every screen shares —
  `writerBlockedReason`, `runnable`, `sizeMb`, `spaceFits`, `spaceReason`,
  `DOWNLOAD_HEADROOM_BYTES` — so no screen re-derives "can the writer run here" on its own.
- **Onboarding** (Step 4): a CPU-gated phone sees "Not this phone" before the rest of the screen
  renders; the writer's card shows the memory sentence with an amber icon and no switch when
  blocked; the Download button is replaced by the disk sentence when the phone lacks space.
- **The Pro screen** (Step 5): the two rows the writer delivers ("Summaries written, not
  extracted", "Minutes that read like minutes") show "Not on this phone." plus the memory
  sentence when blocked; the trial downloads only what `runnable()` keeps and shows the disk
  sentence under the trial button when short on space; the progress line names whichever of
  meaning-index/writer is actually being fetched.
- **Settings** (Step 6): a blocked model's row shows the tag **NOT ON THIS PHONE**, the sentence
  in place of the detail line, and no download pill; tapping a blocked model that somehow still
  reached `onToggle` alerts with the same sentence rather than a native rejection with no context.
- **The Summary tab** (Step 7): the "why there is no summary" check now asks whether the phone is
  capable BEFORE whether a model is installed, and prints the DeviceFit memory sentence instead of
  sending a phone that can never run the writer to *Settings → Models*.
- **Step 8**: no code — `AskScreen` and the meeting's own failure path already carry the same
  processor sentence through `Llm.ask`'s `NOT_CAPABLE` and `NativeBridge.ensureLoaded`'s `check`
  from Step 2. Verified by reading, not by a commit.
- **The probe** (Step 9): `VerificationProbeTest` prints `DeviceFit`'s reading of the tablet —
  total memory, marketed GB, `writerFits`, `cpuFits`, free bytes, and the writer's
  `unsupportedReason` — so this can be read from a session run over adb without touching the
  screen.

## 3. Decisions

- Step 4: the spec's own literal code for `OnboardingScreen.tsx`, applied verbatim, prints
  `grep -c "writerBlocked[^R]"` → `6` (spec says `8`) and `grep -c "spaceShort\|cpuReason"` → `6`
  (spec says `7`). Traced by hand: lines like `{writerBlocked` (the ternary's `?` on the next
  line, exactly as the spec's own snippet has it) end the line right after the identifier, so
  `[^R]` never matches them — true of the spec's given code too, not a transcription error.
  Treated as an arithmetic slip in the spec's narrative, not a stop condition: the formal check
  (`tsc --noEmit` → `0`) passes, and the code is byte-for-byte what the sheet specifies.
- Step 5: the same kind of mismatch. `grep -c "spaceShort"` on `PaywallScreen.tsx` → `3` (spec
  says `4`); the fourth occurrence the spec is counting is `setSpaceShort(...)`, which contains
  `SpaceShort` (capital S), not the lowercase `spaceShort` the pattern requires. Not a stop
  condition, same reasoning.
- Step 9(b): `scripts/device-verify.sh VerificationProbeTest` does not run the probe. `$1` is a
  substring FILTER applied to a fixed `CLASSES` array, and `VerificationProbeTest` is deliberately
  absent from that array — its own (pre-existing) docstring says so: "Runs only by name
  (`am instrument -e class …VerificationProbeTest`); not in device-verify's CLASSES." With the
  filter matching nothing, every class is skipped and the script falls through to its generic
  pass epilogue (the unrelated diarization/VAD/whisper message this run printed). The build+install
  phase, which runs before the class loop, still installed the new probe code, so instead of the
  literal command this session ran the direct invocation the class's own docstring names —
  `adb shell am instrument -w -r -e class com.innocorelabs.verbale.VerificationProbeTest
  com.innocorelabs.verbale.test/androidx.test.runner.AndroidJUnitRunner` — which is exactly what
  `device-verify.sh` does per-class internally. `scripts/device-verify.sh` itself was not edited.

## 4. Tests

| Test | Result | Mutant |
|---|---|---|
| `deviceFit.test.ts` (4 tests) | `Tests: 4 passed` | 4/4 killed and restored: `runnable`'s `!m.unsupportedReason` → `true`; `writerBlockedReason`'s `?? null` → `?? ''`; `sizeMb`'s `/ 1e6` → `/ 1e5`; `spaceFits`'s `>=` → `>` |
| `SummaryTab.test.tsx` (+2 tests) | `Tests: 18 passed` (16 pre-existing + 2 new) | 1/1 killed and restored: `setReason` order swapped back to `!available ? 'no-model' : !capable ? 'weak-device'` |
| `gradlew :app:compileDebugKotlin` (Steps 1, 2) | clean, no `^e:` lines | — (no mutant named for the native gate change) |
| `gradlew :app:compileDebugAndroidTestKotlin` (Step 9a) | clean, no `^e:` lines | — |
| `npx tsc --noEmit` (Steps 4, 5, 6, 7) | `0` errors, every step | — |
| `VerificationProbeTest` (device) | `OK (1 test)` | — |

## 5. Gate

```
    ok  types (2s)
    ok  js (7s)
    ok  scans (2s)
    ok  mutations (105s)
    ok  kotlin (5s)
    ok  cpp (26s)
    ok  device (0s)
gate: all clear in 147s
```

The device stage skips itself while the emulator (`emulator-5554`) is attached alongside the
tablet — §2 Step 9(b)/(c) above is the device evidence for this session.

## 6. Device

Galaxy Tab A (`R52N611D8FE`, 32-bit bench build, 2 GB). The `PROBE device:` line, verbatim:

```
PROBE device: total=1862561792 marketed=2 GB writerFits=false cpuFits=true free=5422104576 reason=Writing the minutes in plain English needs a phone with 4 GB of memory; this one has 2 GB.
```

`total`/`marketed`/`writerFits`/`reason` match the sheet's prediction exactly. `cpuFits=true`
because this is the 32-bit bench build — the same tablet's A53+A73 cores would read `false` under
a 64-bit build, which is the point of the check; it cannot be exercised on this device by design.

**Review (the brain, 21 Sep).** Faithful: every file byte-for-byte the sheet's where the sheet gave
code; file set exactly §5; tree clean; no worktree. Kotlin JVM suites forced (`cleanTestDebugUnitTest`):
305 tests, 0 failed; the other stages re-run clear. The three deviations in §3 are all the sheet's:
two grep counts miscounted by the brain, and `device-verify.sh <Filter>` — which printed "passed"
having run nothing; fixed in review (a filter that matches no class now fails and prints the
`am instrument` line to run instead). **End-to-end on the tablet:** the release build's onboarding
shows *…downloads 227 MB more. Writing the minutes in plain English needs a phone with 4 GB of
memory; this one has 2 GB.* and the writer card amber, sentence, no switch — §7 step 1 as written.

## 7. For the founder to test by hand (on the Galaxy Tab A, 2 GB)

1. **Onboarding.** Under *Try Pro free for 7 days* the note ends *…downloads 227 MB more. Writing
   the minutes in plain English needs a phone with 4 GB of memory; this one has 2 GB.* The *Write
   the minutes in plain English* card has an amber icon, reads that sentence followed by *The
   minutes here are pulled out by rule, and everything else in Pro works on this phone.*, and has
   **no switch**. Tap *Try Pro free for 7 days*: the button reads *Download (227 MB)* — the larger
   transcriber and the meaning index; never 1300-odd. Take it (Wi-Fi).
2. **Settings › On-device models.** *Writes the minutes in plain English* shows the tag **NOT ON
   THIS PHONE**, the sentence in place of its description, and no *Get*. *Finds what was meant…*
   (the meaning index) shows *PRO* and is installed. Every other row is as before.
3. **The Pro screen** (Settings › the subscription row, or the paywall from a meeting): *Summaries
   written, not extracted* and *Minutes that read like minutes* carry an amber icon and a second
   line *Not on this phone. Writing the minutes … this one has 2 GB.*; *Search everything…* and
   *The larger transcriber* do not.
4. **A meeting.** Record two minutes of speech and let it finish. Summary tab: the card says
   *Writing the minutes in plain English needs a phone with 4 GB of memory; this one has 2 GB.* —
   not *Settings → Models*, and no *Write it again*.
5. **Nothing was downloaded that cannot run:** Settings › Storage (or the models list) shows no
   1.1 GB writer; the tablet's free space did not drop by a gigabyte.
6. **The disk sentence** (any phone): fill the phone until under ~300 MB is free (a few large
   videos in the camera app), open Settings › On-device models, remove *Writes down what was
   said, more accurately* (Whisper small), tap *Get* on it: the alert reads *Could not download*
   — *Downloading Whisper small needs 295 MB free; this phone has N MB free. Clear some space and
   try again.* — and nothing was fetched. Delete the videos.
7. **The processor sentence** cannot be shown on the tablet (its 32-bit build passes by design) or
   on any v8.2 phone. It is proved by `DeviceFitTest` against the real feature lines of A53, A73
   and A76 cores; the first Helio G80/G85 or Snapdragon 636/660 phone we borrow shows *Not this
   phone* on onboarding with the sentence, and nothing downloads.

## 8. Known gaps

- The two grep-count self-checks in Steps 4 and 5 (§3 above) don't match the spec's own literal
  code; recorded as spec arithmetic, not code defects — nothing in the actual behaviour is
  affected, and the formal `tsc --noEmit` checks all pass.
- ~~Step 9(b)'s literal `device-verify.sh` invocation does not exercise `VerificationProbeTest`~~ —
  **closed in review:** the script now fails on a filter that matches no class and prints the
  `am instrument` command for a class outside the list.
- The processor sentence (§6, §7 point 7) has no end-to-end device proof in this session — no
  available test device lacks the ARMv8.2 fp16/dot-product instructions. Coverage today is
  `DeviceFitTest`'s unit-level check against real A53/A73/A76 `/proc/cpuinfo` feature lines; live
  confirmation needs a borrowed Helio G80/G85 or Snapdragon 636/660 phone.
- §7's by-hand run is the founder's own step and was not performed by this session — the 32-bit
  release APK is installed on the tablet and ready for it.

## 9. Commits

```
65ec0cc refactor(device): Narrator and LlmModule read the gate from DeviceFit
c5416ed docs(device): progress file — Step 1 done
d911ff8 feat(device): rows carry unsupportedReason, deviceFit() reports the phone, download() and the engine load refuse what it cannot run
7d937bd docs(device): progress file — Step 2 done
b3453d9 feat(device): deviceFit.ts — the screens' reading of the rows and of the phone
7123cac docs(device): progress file — Step 3 done
96a30c4 feat(device): onboarding says what this phone cannot run — the processor, the writer, the disk — before any button
1b6ab7c docs(device): progress file — Step 4 done, end of Run A
c35116b feat(device): the Pro screen says "Not on this phone" on the rows the writer delivers
831e6e9 docs(device): progress file — Step 5 done
ffd0b78 feat(device): Settings shows NOT ON THIS PHONE and the sentence instead of Get
ed51fa8 docs(device): progress file — Step 6 done
4483865 fix(device): the Summary tab blames the phone before the missing model
bc7e277 docs(device): progress file — Step 7 done
3837d4b docs(device): progress file — Step 8 verified, no code change
<this commit> docs(device): device-fit report; progress file retired
```
