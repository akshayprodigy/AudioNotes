#!/usr/bin/env python3
"""Compose the Play Store screenshot set.

Play wants each phone screenshot between 1:2 and 2:1. A raw capture off this emulator is
1080x2424 (1 : 2.24) and is rejected as-is, so every shot is placed on a 1080x1920 (9:16) frame
under a headline. Copy is claim-for-claim what the app actually does - the free tier's 15-minute
cap and the on-device promise are both in the paywall copy.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compose import compose

S = os.path.dirname(os.path.abspath(__file__))
RAW, OUT = os.path.join(S, 'aso'), os.path.join(S, 'aso', 'out')
os.makedirs(OUT, exist_ok=True)

# key, headline, sub, pixels to trim off the bottom of the raw capture
SHOTS = [
    ('recording', 'Just hit record',            'It keeps going with the screen off.'),
    ('summary',   'Your meeting, written up',   'Plain English, the moment it ends.'),
    ('mom',       'Minutes, not a transcript',  'Sectioned the way you would write them.'),
    ('decisions', 'Every decision, with proof', 'Tap the timestamp to hear it said.'),
    ('actions',   'Who owes what, by when',     'Owners and dates, pulled out for you.'),
    # Not "who said what": diarization collapsed a three-voice recording into one speaker on this
    # emulator, and a store screenshot is a promise. Ask is the differentiator that does hold up.
    ('ask',       'Ask the meeting anything',   'Every answer points at the line it came from.', 600),
    ('review',    'It shows you its doubts',    'Confirm it, fix it, or throw it out.', 600),
    ('privacy',   'Nothing leaves your phone',  'No cloud. No account. Nothing uploaded.'),
]

made = []
for i, row in enumerate(SHOTS, 1):
    key, head, sub = row[0], row[1], row[2]
    trim = row[3] if len(row) > 3 else 0
    src = os.path.join(RAW, f'raw-{key}.png')
    if not os.path.exists(src):
        print(f'  -- skipped {key} (no capture yet)')
        continue
    dst = os.path.join(OUT, f'{i:02d}-{key}.png')
    compose(src, head, sub, dst, crop_bottom=trim)
    made.append(dst)
    print(f'  ok {os.path.basename(dst)}')
print(f'{len(made)} frame(s)')
