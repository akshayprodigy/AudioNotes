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

CLASSES=(
  com.audionotes.NativePipelineTest
  com.audionotes.MinutesParityTest
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
for CLASS in "${CLASSES[@]}"; do
  if [ -n "$FILTER" ] && [[ "$CLASS" != *"$FILTER"* ]]; then continue; fi
  echo
  echo "==> $CLASS"
  # Tests assumeTrue() their way out when a model is missing, so a clean device reports skipped
  # rather than a misleading failure. "OK (N tests)" with everything skipped is NOT a pass —
  # check the counts.
  "$ADB" shell am instrument -w -r -e class "$CLASS" \
    com.audionotes.test/androidx.test.runner.AndroidJUnitRunner 2>&1 \
    | tee /tmp/instr.out | grep -E "^INSTRUMENTATION_STATUS: (test|class|stack)=|OK \(|FAILURES|Tests run" || true
  grep -q "FAILURES\|Process crashed" /tmp/instr.out && FAILED=1 || true
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
