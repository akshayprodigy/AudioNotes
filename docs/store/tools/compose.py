#!/usr/bin/env python3
"""Compose Play Store screenshots from raw device captures.

Play rejects anything outside a 1:2 ratio and a raw Pixel 9 capture is 1:2.24, so the capture is
placed on a 1080x1920 (9:16) frame with a headline above it. Fonts and colours are the app's own.
"""
import sys, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1080, 1920
INK = (22, 25, 44)
SOFT = (91, 96, 118)
PRIMARY = (74, 86, 210)
TOP = (238, 240, 251)
BOT = (255, 255, 255)
FONTS = os.path.join(os.path.dirname(__file__), 'fonts')

def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)

def wrap(draw, text, f, maxw):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=f) <= maxw:
            cur = t
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

def rounded(img, r):
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0]-1, img.size[1]-1], radius=r, fill=255)
    out = img.convert('RGBA')
    out.putalpha(mask)
    return out

def compose(shot_path, headline, sub, out_path, crop_top=0, crop_bottom=0, phone_w=768):
    bg = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(bg)
    for y in range(H):                       # vertical gradient
        t = y / (H - 1)
        d.line([(0, y), (W, y)], fill=tuple(int(TOP[i] + (BOT[i]-TOP[i]) * t) for i in range(3)))

    hf, sf = font('Nunito-ExtraBold.ttf', 66), font('Nunito-SemiBold.ttf', 36)
    y = 96
    for line in wrap(d, headline, hf, W - 150)[:2]:
        d.text((W/2, y), line, font=hf, fill=INK, anchor='ma')
        y += 82
    if sub:
        y += 10
        for line in wrap(d, sub, sf, W - 190)[:2]:
            d.text((W/2, y), line, font=sf, fill=SOFT, anchor='ma')
            y += 48

    shot = Image.open(shot_path).convert('RGB')
    top = y + 70
    # A short screen (the review queue is one card and three buttons) leaves the rest of the
    # capture empty. crop_bottom trims that dead tail, but only as far as the card still runs off
    # the bottom of the frame the way the long ones do -- one card floating clear of the edge
    # while the rest bleed is worse than the dead space it saves.
    if crop_top or crop_bottom:
        keep = int((H - top) * shot.width / phone_w) + 8
        bottom = min(crop_bottom, max(0, shot.height - crop_top - keep))
        shot = shot.crop((0, crop_top, shot.width, shot.height - bottom))
    scale = phone_w / shot.width
    shot = shot.resize((phone_w, int(shot.height * scale)), Image.LANCZOS)
    card = rounded(shot, 40)

    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [(W-phone_w)//2, top + 16, (W+phone_w)//2, H + 200], radius=40, fill=(30, 35, 90, 70))
    bg = Image.alpha_composite(bg.convert('RGBA'), shadow.filter(ImageFilter.GaussianBlur(26)))
    bg.paste(card, ((W - phone_w)//2, top), card)
    bg.convert('RGB').save(out_path, 'PNG')
    return out_path

if __name__ == '__main__':
    print(compose(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else '', sys.argv[4]))
