#!/bin/bash
# The gate: every check this project has, in order, stopping at the first failure.
# Run by hand (`npm run gate`) and by git before every push (scripts/hooks/pre-push).
# Design: docs/superpowers/specs/2026-09-15-local-gate-design.md
#
# Overrides, all optional:
#   GATE_STAGES="types js"     run only these stages, in this order
#   GATE_FAKE_FAIL=<stage>     make that stage fail without running it (the gate's own test)
#   ADB=/path/to/adb           where adb is; discovered from the SDK otherwise
#   CMAKE=/path/to/cmake       where cmake is; the Android SDK's copy otherwise
#   VERBALE_LLM_GGUF=<file>    the Qwen GGUF for cpp's test_classify_live; defaults to eval/models
#   VERBALE_EMBED_GGUF=<file>  the bge-small GGUF for cpp's test_embed; defaults to the copy
#                              Task 1 of the ask plan fetched to ~/.cache/verbale-models — the
#                              test skips itself, exit 0, when the file is absent
set -u
cd "$(dirname "$0")/.." || exit 2

STAGES="${GATE_STAGES:-types js scans mutations kotlin cpp device}"
FAKE_FAIL="${GATE_FAKE_FAIL:-}"
CMAKE="${CMAKE:-$HOME/Library/Android/sdk/cmake/3.22.1/bin/cmake}"
export VERBALE_EMBED_GGUF="${VERBALE_EMBED_GGUF:-$HOME/.cache/verbale-models/bge-small-en-v1.5-q8_0.gguf}"
# The writer, for cpp's test_classify_live (the classifier against the real Qwen; ~40 s). The
# eval harness's copy is the same file the phone downloads; the test skips itself without it.
export VERBALE_LLM_GGUF="${VERBALE_LLM_GGUF:-$PWD/eval/models/qwen-instruct-q4_k_m.gguf}"
# Phase 4 (remembered voices): the diarizer's embedding model and the AMI fixtures, for cpp's
# test_voices_live — the same-person / different-person cosines that chose the match rule.
export VERBALE_DIAR_SEG="${VERBALE_DIAR_SEG:-$PWD/eval/models/diar_segmentation.onnx}"
export VERBALE_DIAR_EMB="${VERBALE_DIAR_EMB:-$PWD/eval/models/diar_embedding.onnx}"
export VERBALE_FIXTURES="${VERBALE_FIXTURES:-$PWD/eval/fixtures}"
NINJA="$(dirname "$CMAKE")/ninja"
CTEST="$(dirname "$CMAKE")/ctest"

# adb is not on PATH in a plain shell on this machine; the SDK location is. Same search as
# scripts/device-verify.sh, so the two never disagree about which adb they mean.
ADB="${ADB:-$(command -v adb || true)}"
if [ -z "$ADB" ]; then
  for candidate in "${ANDROID_HOME:-}/platform-tools/adb" "$HOME/Library/Android/sdk/platform-tools/adb"; do
    [ -x "$candidate" ] && ADB="$candidate" && break
  done
fi

# ---- stages ---------------------------------------------------------------------------------

stage_types() { npx tsc --noEmit; }

stage_js() { npx jest --silent; }

stage_scans() {
  python3 scripts/check-network-egress.py &&
  python3 scripts/check-prompt-fencing.py &&
  python3 -m unittest discover -s scripts/__tests__ -p 'test_check_*.py' -q &&
  python3 scripts/check-diar-constants.py &&
  python3 scripts/check-engine-encapsulation.py &&
  python3 scripts/check-live-transcript.py
}

stage_mutations() { python3 scripts/mutate-reconciler.py; }

stage_kotlin() { (cd android && ./gradlew :app:testDebugUnitTest -q); }

stage_cpp() {
  if [ ! -f cpp/cli/build/build.ninja ]; then
    "$CMAKE" -S cpp/cli -B cpp/cli/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_MAKE_PROGRAM="$NINJA" || return 1
  fi
  "$CMAKE" --build cpp/cli/build -j 8 && (cd cpp/cli/build && "$CTEST" --output-on-failure)
}

# The phone is included when it is there and never required. Exactly one authorised device runs
# the suite — or the one ANDROID_SERIAL names, when emulators crowd the list (adb honours the
# variable, so the suite lands on that phone). Anything else is reported and passed — a missing
# phone is a fact about the desk. A suite that RUNS and fails fails the stage: an unconditional
# `return 0` here once printed "FAILED — full output in /tmp/instr.out" and then "all clear".
stage_device() {
  if [ -z "$ADB" ] || [ ! -x "$ADB" ]; then
    echo "    no adb — device tests skipped"; return 0
  fi
  local listing authorised unauthorised named
  listing=$("$ADB" devices 2>/dev/null | tail -n +2 | awk 'NF')
  authorised=$(printf '%s\n' "$listing" | awk '$2=="device"' | wc -l | tr -d ' ')
  unauthorised=$(printf '%s\n' "$listing" | awk '$2=="unauthorized"' | wc -l | tr -d ' ')
  named=$(printf '%s\n' "$listing" | awk -v s="${ANDROID_SERIAL:-}" '$1==s && $2=="device"' | wc -l | tr -d ' ')
  if [ "$named" = "1" ]; then
    echo "    device tests on ${ANDROID_SERIAL} (ANDROID_SERIAL)"
    npm run -s test:device; return $?
  elif [ "$authorised" = "1" ]; then
    npm run -s test:device; return $?
  elif [ "$unauthorised" != "0" ]; then
    echo "    phone attached but not authorised — accept the USB debugging prompt; device tests skipped"
  elif [ "$authorised" = "0" ]; then
    echo "    no phone — device tests skipped"
  else
    echo "    $authorised phones attached — device tests skipped (attach one)"
  fi
  return 0
}

# ---- runner ---------------------------------------------------------------------------------

run_stage() {
  local name=$1 start rc elapsed
  start=$(date +%s)
  echo "==> $name"
  if [ "$FAKE_FAIL" = "$name" ]; then
    echo "    (GATE_FAKE_FAIL: failing this stage on purpose)"
    rc=1
  else
    "stage_$name"
    rc=$?
  fi
  elapsed=$(( $(date +%s) - start ))
  if [ $rc -eq 0 ]; then
    echo "    ok  $name (${elapsed}s)"
  else
    echo "    FAILED  $name (${elapsed}s)"
  fi
  return $rc
}

overall_start=$(date +%s)
for stage in $STAGES; do
  if ! declare -f "stage_$stage" >/dev/null; then
    echo "unknown stage: $stage (known: types js scans mutations kotlin cpp device)"; exit 2
  fi
  if ! run_stage "$stage"; then
    echo
    echo "gate: $stage failed after $(( $(date +%s) - overall_start ))s — push refused. (git push --no-verify skips the gate.)"
    exit 1
  fi
done
echo
echo "gate: all clear in $(( $(date +%s) - overall_start ))s"
exit 0
