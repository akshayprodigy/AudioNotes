#!/bin/bash
# The dataSync foreground-service video Play asks for, in one take.
#
# What the reviewer has to see: the work is a single multi-minute computation the user is waiting
# for, it reports which stage is running and how far along it is, and it keeps going while the app
# is in the background. A short clip is used so the whole pipeline finishes inside one recording.
set -e
A=/Users/akshayghosh/Library/Android/sdk/platform-tools/adb
D=emulator-5556
OUT=$1

$A -s $D shell "am start -a android.intent.action.VIEW -d content://media/external/audio/media/20 -t audio/wav -f 1 -n com.innocorelabs.verbale/.MainActivity" >/dev/null
sleep 5
$A -s $D shell input tap 835 1383       # TRANSCRIBE
sleep 3

$A -s $D shell screenrecord --size 720x1616 --bit-rate 6000000 --time-limit 170 /sdcard/fgs-sync.mp4 &
REC=$!
sleep 20                                 # the in-app progress screen, stages ticking over
$A -s $D shell input keyevent KEYCODE_HOME
sleep 4
$A -s $D shell cmd statusbar expand-notifications    # the processing notification
sleep 14
$A -s $D shell cmd statusbar collapse
sleep 20
$A -s $D shell cmd statusbar expand-notifications    # again, further along
sleep 14
$A -s $D shell cmd statusbar collapse
sleep 3
$A -s $D shell am start -n com.innocorelabs.verbale/.MainActivity >/dev/null
sleep 80                                 # back in the app, through to the finished notes

wait $REC || true
sleep 3
$A -s $D pull /sdcard/fgs-sync.mp4 "$OUT"
$A -s $D shell rm -f /sdcard/fgs-sync.mp4
echo "$OUT"
