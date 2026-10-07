#!/usr/bin/env bash
# Regenerates the bundled sample meeting: the audio the app ships and the JSON it seeds from.
#
#   scripts/make-sample-meeting.sh
#
# macOS only (it uses `say`). Needs ffmpeg, python3, node, and the repo's CLI already built
# (cpp/cli/build/audionotes_cli) with the eval models in eval/models. Everything it writes is
# committed, and running it twice gives the same JSON for the same audio:
#
#   android/app/src/main/res/raw/sample_meeting.m4a   the audio, ~250 KB (AAC, mono, 32 kbps)
#   src/sample/sampleMeeting.json                      utterances, speakers, items, summary
#
# What each stage is for, because the sample has to be honest about where it came from:
#   1. scripts/sample-meeting/script.txt is the fictional "Weekly check-in". Each line is one
#      speaker's turn, voiced by a different macOS `say` voice and joined with a pause, so the
#      result is one mono file with two voices that VAD can split into turns.
#   2. The m4a is what ships. It is decoded straight back to 16 kHz mono and that is what the
#      pipeline transcribes, so the timings are those of the audio the app actually plays.
#   3. The REAL pipeline (audionotes_cli: VAD + whisper-base) produces the utterance text and
#      times. Nothing in them is typed by hand.
#   4. scripts/sample-meeting-bundle.js maps each utterance to the script line it overlaps (that
#      is where "Priya" and "Sam" come from: two synthetic voices diarize as one speaker), and
#      runs the app's own rule extractor (src/pipeline/minutes.ts, evidence.ts) over the result
#      for the items, their owners, due dates and anchors, and the summary.
#
# WORK defaults to a temp directory; set WORK=... to keep the intermediates.
set -euo pipefail
cd "$(dirname "$0")/.."

CLI="${CLI:-cpp/cli/build/audionotes_cli}"
WHISPER="${WHISPER:-eval/models/ggml-base-q5_1.bin}"
VAD="${VAD:-eval/models/silero_vad.onnx}"
WORK="${WORK:-$(mktemp -d)}"
M4A="android/app/src/main/res/raw/sample_meeting.m4a"
SCRIPT="scripts/sample-meeting/script.txt"
GAP_MS=700
LEAD_MS=400

for f in "$CLI" "$WHISPER" "$VAD" "$SCRIPT"; do
  [ -e "$f" ] || { echo "missing: $f" >&2; exit 1; }
done
command -v say >/dev/null && command -v ffmpeg >/dev/null || { echo "needs macOS say and ffmpeg" >&2; exit 1; }

# 1. One clip per line, 16 kHz mono.
i=0
: > "$WORK/lines.tsv"
while IFS='|' read -r speaker voice text; do
  i=$((i + 1))
  say -v "$voice" -r 165 -o "$WORK/l$i.aiff" "$text"
  ffmpeg -v error -y -i "$WORK/l$i.aiff" -ar 16000 -ac 1 -c:a pcm_s16le "$WORK/l$i.wav"
  printf '%s\t%s\t%s\n' "$i" "$speaker" "$text" >> "$WORK/lines.tsv"
done < <(grep -v '^#' "$SCRIPT")

# 2. Join with silence and write where each line sits (lines.json), then encode what ships.
python3 -I - "$WORK" "$GAP_MS" "$LEAD_MS" <<'PY'
import json, sys, wave
work, gap_ms, lead_ms = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
rows = [l.rstrip("\n").split("\t") for l in open(f"{work}/lines.tsv")]
RATE = 16000
silence = lambda ms: b"\x00\x00" * (RATE * ms // 1000)
pcm, pos, lines = silence(lead_ms), lead_ms, []
for n, speaker, text in rows:
    with wave.open(f"{work}/l{n}.wav") as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1
        clip = w.readframes(w.getnframes())
    ms = len(clip) // 2 * 1000 // RATE
    lines.append({"speaker": speaker, "text": text, "startMs": pos, "endMs": pos + ms})
    pcm += clip + silence(gap_ms)
    pos += ms + gap_ms
with wave.open(f"{work}/joined.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(pcm)
json.dump(lines, open(f"{work}/lines.json", "w"), indent=1)
PY
mkdir -p "$(dirname "$M4A")"
ffmpeg -v error -y -i "$WORK/joined.wav" -map_metadata -1 -fflags +bitexact -flags:a +bitexact \
  -c:a aac -b:a 32k -ar 16000 -ac 1 "$M4A"
ffmpeg -v error -y -i "$M4A" -ar 16000 -ac 1 -c:a pcm_s16le "$WORK/shipped.wav"

# 3. The real pipeline over exactly that audio.
"$CLI" "$WHISPER" "$WORK/shipped.wav" --vad "$VAD" --json "$WORK/run.json" >/dev/null

# 4. The bundle.
node scripts/sample-meeting-bundle.js "$WORK/run.json" "$WORK/lines.json" src/sample/sampleMeeting.json
ls -l "$M4A" src/sample/sampleMeeting.json
