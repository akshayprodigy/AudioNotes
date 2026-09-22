#!/bin/bash
# The microphone foreground-service video Play asks for, in one take.
#
# The point the reviewer has to see is that recording SURVIVES leaving the app: start it, go to
# the launcher, watch the picture-in-picture control and the notification keep counting, come
# back, stop it. No editing.
set -e
D=${1:-emulator-5556}
A=/Users/akshayghosh/Library/Android/sdk/platform-tools/adb
OUT=${2:-/tmp/fgs-microphone.mp4}

$A -s $D shell screenrecord --size 720x1616 --bit-rate 6000000 --time-limit 100 /sdcard/fgs-mic.mp4 &
REC=$!
sleep 2

$A -s $D shell input tap 538 2216        # Record
sleep 4
$A -s $D shell input tap 538 1668        # the mic button: recording starts
sleep 10                                  # let the timer climb so it is visibly running
$A -s $D shell input keyevent KEYCODE_HOME   # leave the app -> PiP
sleep 8
$A -s $D shell cmd statusbar expand-notifications   # the recording notification
sleep 8
$A -s $D shell cmd statusbar collapse
sleep 3
$A -s $D shell am start -n com.innocorelabs.verbale/.MainActivity  # back into the app
sleep 6
$A -s $D shell input tap 538 1706        # stop
sleep 12

wait $REC || true
sleep 2
$A -s $D pull /sdcard/fgs-mic.mp4 "$OUT"
$A -s $D shell rm -f /sdcard/fgs-mic.mp4
echo "$OUT"
