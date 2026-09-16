#!/usr/bin/env bash
# On-device verification of the native core.
#
# Deliberately NOT `./gradlew connectedDebugAndroidTest`. That task UNINSTALLS the app when it
# finishes, which wipes the downloaded models (~112 MB) AND the database — it destroyed real
# recordings once. Installing both APKs and driving the runner with `am instrument` leaves app
# data alone.
#
#   scripts/device-verify.sh              # the native core tests
#   scripts/device-verify.sh Minutes      # only classes matching a substring
set -euo pipefail

cd "$(dirname "$0")/.."
FILTER="${1:-}"

# adb is not on PATH in a plain shell on this machine; the SDK location is.
ADB="${ADB:-$(command -v adb || true)}"
for candidate in "$ANDROID_HOME/platform-tools/adb" "$HOME/Library/Android/sdk/platform-tools/adb"; do
  [ -n "$ADB" ] && break
  [ -x "$candidate" ] && ADB="$candidate"
done
if [ -z "$ADB" ]; then
  echo "adb not found. Set ADB=/path/to/adb, or install platform-tools."
  exit 1
fi

# Package-qualified, and the package is the one the sources actually declare. These went stale at
# the rename: the classes moved to com.innocorelabs.verbale and this list did not, so every run
# reported "OK (0 tests)" — a pass, for having run nothing.
CLASSES=(
  com.innocorelabs.verbale.NativePipelineTest
  com.innocorelabs.verbale.MinutesParityTest
  # The `touched` predicate spans four tables and SQLite is the only thing that can answer it, so
  # this one cannot be a JVM test. A class missing from this list does not fail — it never runs.
  com.innocorelabs.verbale.ItemsDbTest
  # The library migration: rule pass over stored utterances, and the ticks moved off action_done.
  # Both halves are SQLite plus the native rules, so neither can be a JVM test.
  com.innocorelabs.verbale.BackfillTest
  # The corrections half of the same migration, and the one whose failure is total and silent:
  # `edits` has a foreign key to `meetings` and none to `items`, so a reader switched to item ids
  # without this simply joins to nothing — every correction in every install, no error anywhere.
  # It needs real SQLCipher and the real ItemKey, and it seeds the string the real extractor
  # produces, so it cannot be a JVM test.
  com.innocorelabs.verbale.BackfillEditsTest
  # A backup is only worth what comes back out of it, and BackupManager.TABLES is a private list of
  # strings whose ORDER decides whether a restore keeps an item's evidence or cascades it away.
  com.innocorelabs.verbale.BackupManagerTest
  # Its own class because NativeBridge.loaded is static: once anything in a process has loaded the
  # core, nothing after it can tell whether the caller under test would have. Each entry here gets
  # its own `am instrument`, and so its own process — which is the whole mechanism of that test.
  com.innocorelabs.verbale.StorageItemsTest
  # The library-wide sweep: which meetings are in the backlog, and that a meeting whose transcript
  # legitimately yields NO items leaves it. Both halves are a real database plus the native rules,
  # and the second cannot be a JVM test for the same reason none of the above can be.
  com.innocorelabs.verbale.ItemSweepTest
  # Its own class for the reason StorageItemsTest is: NativeBridge.loaded is static, so only a
  # process that has loaded nothing can tell whether the sweep loads the core itself. One class,
  # one `am instrument`, one process — that IS the mechanism, and ItemSweepTest cannot stand in for
  # it because its own helper loads the core before every test.
  com.innocorelabs.verbale.StorageSweepTest
  # Every decision and action anybody has ever TYPED, moved out of `minutes` and into `items` —
  # with its tick, its correction, and the `minutes` row deleted behind it. Task 12 stops the tabs
  # and the export merging those rows back in, so a migration that does not run makes every
  # hand-written item disappear from the meeting it was typed into, silently. A move between two
  # tables, a tick re-keyed, a correction re-keyed and a delete: SQLite from end to end, so none
  # of it can be a JVM test.
  com.innocorelabs.verbale.UserItemsMigrationTest
  # Re-diarization keeps a person's speaker work: SQL against SQLCipher, so not a JVM test.
  com.innocorelabs.verbale.SpeakerRepairDbTest
)

if ! "$ADB" devices | grep -qE "device$"; then
  echo "No device. Check the cable, and that USB debugging is on —"
  echo "a phone in MTP-only mode shows up in system_profiler but not in 'adb devices'."
  exit 1
fi

# Which key the debug build is signed with is not a preference — it has to match whatever is
# already on the phone. Signatures that differ mean INSTALL_FAILED_UPDATE_INCOMPATIBLE, and the
# only way past that is an uninstall, which takes the downloaded models and the recordings
# database with it. That is the one thing this script exists to avoid.
#
# The phone can be carrying any of three things: a release build signed with the upload key, a
# debug build from this script signed with that same key, or a plain debug-key build. dumpsys
# reports no signer in a form worth parsing, and "is it debuggable" answers the wrong question —
# so try the likely key and fall back to the other. Worst case is two builds, both of which Gradle
# has already cached.
APK=android/app/build/outputs/apk/debug/app-debug.apk
TEST_APK=android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk

SIGN_FLAGS=""
if grep -qs '^AUDIONOTES_STORE_FILE' "$HOME/.gradle/gradle.properties"; then
  SIGN_FLAGS="-PAUDIONOTES_DEBUG_UPLOAD_SIGNING"
fi

# `adb install` prints "Failure [...]" and still exits 0, so set -e never sees it and the run
# carries on testing whichever build was already on the phone. Check the output, not the status.
INSTALL_ERR=""
install_apk() {
  local out
  out=$("$ADB" install -r "$1" 2>&1 || true)
  if printf '%s' "$out" | grep -q 'Failure\|failed to install'; then
    INSTALL_ERR="$out"
    return 1
  fi
  return 0
}

# A build failure inside `attempt` used to be invisible. `set -e` is suspended for a function
# called as an `if` condition, so a broken androidTest compile carried straight on to the install,
# which happily pushed WHATEVER APK was still on disk from the last successful build. The tests
# then ran against stale code and failed against the old JNI signature — which reads exactly like
# a product bug and cost two full device cycles before anybody suspected the script.
#
# So the build is checked on its own and is fatal. The retry below exists for a signature
# mismatch on INSTALL, and re-running the compiler with a different signing flag cannot fix code
# that does not compile.
build_or_die() {
  echo "==> building${1:+ (signed with the upload key)}"
  if ! (cd android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest -q $1); then
    echo ""
    echo "BUILD FAILED — nothing was installed, so the phone still has the previous build." >&2
    echo "Fix the compile error above and re-run. Do NOT read the test results from a previous" >&2
    echo "run as if they described this code." >&2
    if [ -n "${1:-}" ]; then
      echo "(Built with $1. If the failure is about the keystore rather than the code, unset" >&2
      echo " AUDIONOTES_STORE_FILE in ~/.gradle/gradle.properties and try again.)" >&2
    fi
    exit 1
  fi
  # Belt and braces: a build that "succeeded" without producing the test APK would put us straight
  # back into installing something stale.
  for apk in "$APK" "$TEST_APK"; do
    if [ ! -f "$apk" ]; then
      echo "BUILD reported success but $apk does not exist." >&2
      exit 1
    fi
  done
}

attempt() {
  INSTALL_ERR=""
  build_or_die "${1:-}"
  echo "==> installing (-r keeps app data, and with it the downloaded models)"
  # Not while the app is on screen. Android 15+ relaunches a foreground app's activity after an
  # in-place update, and the debug build carries no JS bundle (Metro's job), so the relaunched
  # MainActivity died with "Unable to load script" in the very process the first test class was
  # instrumenting — reported as "Process crashed" with nothing else to read. Seen on the Pixel,
  # 15 Sep, when the gate ran with the Library open.
  "$ADB" shell am force-stop com.innocorelabs.verbale >/dev/null 2>&1 || true
  "$ADB" shell input keyevent KEYCODE_HOME >/dev/null 2>&1 || true
  install_apk "$APK" && install_apk "$TEST_APK"
}

if ! attempt "$SIGN_FLAGS"; then
  if ! printf '%s' "$INSTALL_ERR" | grep -q 'UPDATE_INCOMPATIBLE'; then
    printf '%s\n' "$INSTALL_ERR"
    exit 1
  elif [ -n "$SIGN_FLAGS" ]; then
    echo "==> the installed build is not signed with the upload key; retrying with the debug key"
    attempt "" || { printf '%s\n' "$INSTALL_ERR"; exit 1; }
  else
    echo "The installed build is signed with a key this machine does not have. Set"
    echo "AUDIONOTES_STORE_FILE in ~/.gradle/gradle.properties, or uninstall the app first —"
    echo "which WIPES the downloaded models and the recordings database."
    exit 1
  fi
fi

FAILED=0
: > /tmp/instr.skips
: > /tmp/instr-run.out
for CLASS in "${CLASSES[@]}"; do
  if [ -n "$FILTER" ] && [[ "$CLASS" != *"$FILTER"* ]]; then continue; fi
  echo
  echo "==> $CLASS"
  # Tests assumeTrue() their way out when a model is missing, so a clean device reports skipped
  # rather than a misleading failure. "OK (N tests)" with everything skipped is NOT a pass —
  # check the counts.
  "$ADB" shell am instrument -w -r -e class "$CLASS" \
    com.innocorelabs.verbale.test/androidx.test.runner.AndroidJUnitRunner 2>&1 \
    | tee /tmp/instr.out | grep -E "^INSTRUMENTATION_STATUS: (test|class|stack)=|OK \(|FAILURES|Tests run" || true
  # /tmp/instr.out is this class only; the whole run accumulates in /tmp/instr-run.out, so a
  # crash in the first class is still readable after the last one has overwritten instr.out.
  { echo "==> $CLASS"; cat /tmp/instr.out; } >> /tmp/instr-run.out
  if grep -q "FAILURES\|Process crashed" /tmp/instr.out; then
    FAILED=1
    grep -m1 -E "INSTRUMENTATION_RESULT: (shortMsg|longMsg)=.*" /tmp/instr.out | sed 's/^/  /' || true
  fi
  # A run that matched no class reports "OK (0 tests)" and exits clean, which is how a stale
  # class name went unnoticed. Nothing here is allowed to pass by not running.
  if grep -q "OK (0 tests)" /tmp/instr.out; then
    echo "  no tests matched $CLASS — is the class name still right?"
    FAILED=1
  fi

  # ...and neither is a run that matched every test and then skipped them all. The tests
  # assumeTrue() their way out when the models are absent, so a freshly wiped device reports
  # "OK (7 tests)" having verified precisely nothing — which is the same lie as "OK (0 tests)"
  # wearing a bigger number. This is not hypothetical: it is what this script printed, epilogue
  # and all, on the first run after the models were wiped.
  TOTAL=$(grep -o 'INSTRUMENTATION_STATUS: test=.*' /tmp/instr.out | sort -u | wc -l | tr -d ' ')
  SKIPPED=$(grep -c 'AssumptionViolatedException' /tmp/instr.out || true)
  if [ "$SKIPPED" -gt 0 ]; then
    echo "  $SKIPPED of $TOTAL skipped — the assumption they guard was not met:"
    grep -o 'AssumptionViolatedException: .*' /tmp/instr.out | sort -u | sed 's/^/    /'
    grep -o 'AssumptionViolatedException: .*' /tmp/instr.out | sort -u >> /tmp/instr.skips
    if [ "$SKIPPED" -ge "$TOTAL" ]; then
      echo "  every test skipped, so this class verified NOTHING."
      echo "  Download the models first (open the app and finish onboarding), then re-run."
      FAILED=1
    fi
  fi
done

echo
if [ "$FAILED" = "1" ]; then
  echo "FAILED — full output in /tmp/instr-run.out (every class, in order)"
  exit 1
fi
echo "passed. What this run is actually gating:"
echo "  * diarization does not fragment one speaker into a crowd (the 1.0 merge threshold)"
echo "  * VAD + sherpa share one ONNX Runtime without crashing"
echo "  * minutes match the TypeScript goldens byte-for-byte"
echo "  * whisper and the LLM load and produce output on ARM"

# ...minus whatever skipped. That list above is a fixed claim, and printing it whole after a run
# where the Qwen tests all skipped said "the LLM loads and produces output on ARM" on the strength
# of having never loaded it. A summary that overstates its own coverage is the thing this script
# keeps getting wrong, so the shortfall is printed with the claim rather than left to be inferred.
if [ -s /tmp/instr.skips ]; then
  echo
  echo "NOT exercised by this run — tests skipped themselves because:"
  sort -u /tmp/instr.skips | sed 's/AssumptionViolatedException: /  * /'
  echo "  Anything above that depends on these was NOT checked."
fi
