#!/bin/bash
# Break the Share screen's Pro/MP3 rules one at a time; every line must report failed tests.
# Restores the file when done. (JS twin of mutate-export.py, which does the Kotlin rules.)
set -u
cd "$(dirname "$0")/.."
F=src/share/SharePreviewScreen.tsx
cp $F ${TMPDIR:-/tmp}/SPS.bak
run() { # name, python-replace-from, to
  cp ${TMPDIR:-/tmp}/SPS.bak $F
  python3 - "$2" "$3" <<'PY'
import sys
p='src/share/SharePreviewScreen.tsx'
s=open(p).read()
a,b=sys.argv[1],sys.argv[2]
assert s.count(a)==1,(a,s.count(a))
open(p,'w').write(s.replace(a,b,1))
PY
  out=$(npx jest src/share --silent 2>&1 | grep -E "^Tests:")
  echo "$1 -> $out"
}
run "PRO_REQUIRED branch removed" "if (e?.code === 'PRO_REQUIRED') {" "if (false) {"
run "AUDIO_DELETED branch removed" "} else if (e?.code === 'AUDIO_DELETED') {" "} else if (false) {"
run "cancelled shown as an error" "e?.code !== 'cancelled'" "true"
run "MP3 always enabled" "disabled={hasAudio !== true}
          onPress={() => setChoice(MP3)}" "disabled={false}
          onPress={() => setChoice(MP3)}"
run "MP3 export goes through shareWith" "await FileExport.exportMp3(meetingId);" "await FileExport.shareWith(meetingId, format, stamped);"
run "audio message never shown" "{hasAudio === false ? (" "{false ? ("
run "Share ready without audio" "isMp3 ? hasAudio === true : shown" "isMp3 ? true : shown"
cp ${TMPDIR:-/tmp}/SPS.bak $F
