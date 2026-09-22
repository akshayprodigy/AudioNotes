#!/usr/bin/env python3
"""The 1024x500 Play Store feature graphic.

Play may crop this and can overlay controls on it, so nothing that matters goes near the edges:
the mark and the words sit in the middle band with a wide margin all round. No alpha channel --
Play rejects one.
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1024, 500
INK = (22, 25, 44)
SOFT = (91, 96, 118)
S = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(S, 'fonts')
ICON = sys.argv[1]
OUT = sys.argv[2]

def font(n, s):
    return ImageFont.truetype(os.path.join(FONTS, n), s)

bg = Image.new('RGB', (W, H))
d = ImageDraw.Draw(bg)
# Diagonal wash of the app's two background tones, light enough that the ink stays legible.
for y in range(H):
    for_x = y / (H - 1)
    top, bot = (238, 240, 251), (255, 255, 255)
    d.line([(0, y), (W, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * for_x) for i in range(3)))

# A soft primary bloom behind the mark, the same one the record screen uses.
bloom = Image.new('RGB', (W, H), (255, 255, 255))
ImageDraw.Draw(bloom).ellipse([40, 60, 460, 480], fill=(228, 232, 250))
bg = Image.blend(bg, bloom, 0.55)
bg = bg.filter(ImageFilter.GaussianBlur(0))

icon = Image.open(ICON).convert('RGBA').resize((300, 300), Image.LANCZOS)
bg.paste(icon, (108, 100), icon)

d = ImageDraw.Draw(bg)

X, RIGHT = 452, W - 84          # the right margin Play must never crop into

def fitted(text, name, size, maxw):
    """Step the size down until the line measures inside the safe area. Hard-coding a size and
    hoping was how the first draft ran 'phone.' off the right edge."""
    while size > 12:
        f = font(name, size)
        if d.textlength(text, font=f) <= maxw:
            return f
        size -= 1
    return font(name, 12)

avail = RIGHT - X
title = 'Verbale'
sub = 'Minutes, written on your phone.'
accent = 'Nothing is uploaded.'

d.text((X, 168), title, font=fitted(title, 'Nunito-ExtraBold.ttf', 96, avail), fill=INK)
d.text((X + 6, 290), sub, font=fitted(sub, 'Nunito-SemiBold.ttf', 36, avail), fill=SOFT)
d.text((X + 6, 340), accent, font=fitted(accent, 'Nunito-ExtraBold.ttf', 36, avail),
       fill=(74, 86, 210))

bg.save(OUT, 'PNG')
print(OUT, bg.size, bg.mode)
