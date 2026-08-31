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
)

if ! "$ADB" devices | grep -qE "device$"; then
  echo "No device. Check the cable, and that USB debugging is on —"
  echo "a phone in MTP-only mode shows up in system_profiler but not in 'adb devices'."
  exit 1
fi

echo "==> building"
(cd android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest -q)

APK=android/app/build/outputs/apk/debug/app-debug.apk
TEST_APK=android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk

echo "==> installing (-r keeps app data, and with it the downloaded models)"
"$ADB" install -r "$APK"      > /dev/null
"$ADB" install -r "$TEST_APK" > /dev/null

FAILED=0
: > /tmp/instr.skips
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
  grep -q "FAILURES\|Process crashed" /tmp/instr.out && FAILED=1 || true
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
  echo "FAILED — full output in /tmp/instr.out"
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
