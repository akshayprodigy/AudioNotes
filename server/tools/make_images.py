#!/usr/bin/env python3
"""
Produce every image the marketing site and blog need, so no page ever shows a missing picture.

Run by hand (it needs Pillow, which is a dev-only dependency; the server never imports it) and
commit the output. It makes three things:

  shots/<name>.webp          the app screen cut out of each Play Store frame, headline removed
  blog/<cover>.webp          1600x900 post cover shown on the article page
  blog/<cover>-og.png        1200x630 version of the same cover for link previews (PNG because it
                             is the format every social crawler accepts)
  og.png                     the site-wide default link preview

Covers share one visual language (brand gradient, soft glows, grain, Nunito title, phone card on
the right bleeding off the bottom edge like the store shots), so a blog index of covers reads as
one product. Everything is deterministic: re-running rewrites identical files.

    python3 tools/make_images.py [--content DIR] [--out DIR]
"""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent
REPO = SERVER.parent
FONTS = REPO / "assets" / "fonts"
MASCOT = HERE / "assets" / "mascot-tile.png"
STORE = REPO / "docs" / "store" / "screenshots"

#: Store frame file -> name used in `/static/shots/<name>.webp` and in a post's `shot:` field.
SHOTS = {
    "01-recording": "recording", "02-summary": "summary", "03-mom": "mom",
    "04-decisions": "decisions", "05-actions": "actions", "06-ask": "ask",
    "07-review": "review", "08-privacy": "privacy",
}
#: The app-screen card inside a composed 1080x1920 store frame (headline sits above y=306).
CARD_BOX = (156, 306, 924, 1920)
SHOT_W = 540
SHOT_QUALITY = 82
CARD_RADIUS = 56          # corner radius of the card in the 768px-wide crop

INDIGO = (74, 86, 210)
VIOLET = (122, 90, 224)
DEEP = (44, 52, 150)
SITE_URL = "verbale.innocorelabs.com"
DEFAULT_SHOT = "summary"


def font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / f"Nunito-{weight}.ttf"), int(size))


# ---------------------------------------------------------------- shots

def make_shots(out: Path) -> list[Path]:
    """Cut the real app screen out of each composed store frame (top corners rounded, bottom bleeds)."""
    dest = out / "shots"
    dest.mkdir(parents=True, exist_ok=True)
    written = []
    for src, name in SHOTS.items():
        card = Image.open(STORE / f"{src}.png").convert("RGB").crop(CARD_BOX)
        mask = Image.new("L", card.size, 0)
        # Draw taller than the card so only the top corners are rounded.
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, card.width - 1, card.height + CARD_RADIUS * 2], radius=CARD_RADIUS, fill=255)
        card.putalpha(mask)
        card = card.resize((SHOT_W, round(card.height * SHOT_W / card.width)), Image.LANCZOS)
        path = dest / f"{name}.webp"
        card.save(path, "WEBP", quality=SHOT_QUALITY, method=6)
        written.append(path)
    return written


def load_shot(out: Path, name: str) -> Image.Image:
    return Image.open(out / "shots" / f"{name}.webp").convert("RGBA")


# ---------------------------------------------------------------- background

def _diagonal(w: int, h: int) -> Image.Image:
    """0..255 ramp running top-left to bottom-right."""
    g = Image.linear_gradient("L")
    v = g.resize((w, h), Image.BILINEAR)
    hz = g.rotate(90, expand=True).transpose(Image.FLIP_LEFT_RIGHT).resize((w, h), Image.BILINEAR)
    return ImageChops.add(v, hz, scale=2)


def _glow(size: tuple[int, int], center: tuple[float, float], radius: float,
          color: tuple[int, int, int], strength: float) -> tuple[Image.Image, Image.Image]:
    # radial_gradient is 0 at the centre and ~181 at the middle of an edge; fall to exactly zero
    # before the edge, quadratically, so no rectangle outline shows where the glow is clipped.
    r = Image.radial_gradient("L").point(lambda p: int(255 * strength * max(0.0, 1 - p / 175) ** 2))
    d = int(radius * 2)
    mask = Image.new("L", size, 0)
    mask.paste(r.resize((d, d), Image.BICUBIC), (int(center[0] - radius), int(center[1] - radius)))
    return Image.new("RGB", size, color), mask


def background(w: int, h: int, grain: int = 7) -> Image.Image:
    ramp = _diagonal(w, h)
    bg = ImageOps.colorize(ramp, black=(60, 70, 196), white=(112, 82, 222), mid=INDIGO)
    for center, radius, color, strength in [
        ((w * 0.82, h * 0.18), h * 0.95, (150, 120, 255), 0.55),   # violet bloom behind the phone
        ((w * 0.05, h * 1.02), h * 0.9, (34, 40, 140), 0.65),      # deep shade bottom-left
        ((w * 0.30, h * -0.05), h * 0.7, (120, 140, 255), 0.30),   # cool light top
    ]:
        layer, mask = _glow((w, h), center, radius, color, strength)
        bg.paste(layer, (0, 0), mask)
    # Grain: breaks up 8-bit banding in the long gradient and stops it looking like clip-art.
    if not grain:
        return bg
    rnd = random.Random(7)
    noise = Image.effect_noise((w, h), grain)
    noise = ImageChops.offset(noise, rnd.randrange(w), rnd.randrange(h))
    return ImageChops.add(bg, Image.merge("RGB", (noise,) * 3), scale=1, offset=-128)


# ---------------------------------------------------------------- pieces

def wrap(draw: ImageDraw.ImageDraw, text: str, f, maxw: float) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        trial = f"{cur} {word}".strip()
        if draw.textlength(trial, font=f) <= maxw or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def fit_title(draw, text: str, maxw: float, maxh: float, start: int, max_lines: int = 3):
    """Largest ExtraBold size (down from `start`) that wraps within max_lines and the box."""
    size = start
    while True:
        f = font("ExtraBold", size)
        lines = wrap(draw, text, f, maxw)
        height = len(lines) * size * 1.12
        fits = len(lines) <= max_lines and height <= maxh and all(
            draw.textlength(l, font=f) <= maxw for l in lines)
        if fits or size <= 28:
            # Balance: narrow the measure while the line count holds, so the last line is not an orphan.
            n, w = len(lines), maxw
            while w > maxw * 0.5:
                w -= 8
                trial = wrap(draw, text, f, w)
                if len(trial) != n or max(draw.textlength(l, font=f) for l in trial) > maxw:
                    break
                lines = trial
            return f, lines, size
        size -= 2


def mark(img: Image.Image, x: int, y: int, s: int) -> int:
    """The real mascot on its white tile (tools/assets/mascot-tile.png), plus the wordmark. Returns the right edge."""
    tile = Image.open(MASCOT).convert("RGBA").resize((s, s), Image.LANCZOS)
    img.alpha_composite(tile, (x, y))
    d = ImageDraw.Draw(img)
    f = font("ExtraBold", s * 0.78)
    d.text((x + s + s * 0.3, y + s / 2), "Verbale", font=f, fill="white", anchor="lm")
    return int(x + s + s * 0.3 + d.textlength("Verbale", font=f))


def phone(shot: Image.Image, width: int, angle: float) -> Image.Image:
    """The shot as a phone card with a bezel, tilted, with a soft shadow baked into the alpha."""
    pad = max(6, width // 40)
    card = shot.resize((width, round(shot.height * width / shot.width)), Image.LANCZOS)
    body = Image.new("RGBA", (width + pad * 2, card.height + pad), (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    bd.rounded_rectangle([0, 0, body.width - 1, body.height + 200], radius=int(width * 0.115),
                         fill=(16, 18, 39, 255))
    body.alpha_composite(card, (pad, pad))
    # Rim light so the bezel separates from the dark gradient.
    ImageDraw.Draw(body).rounded_rectangle(
        [0, 0, body.width - 1, body.height + 200], radius=int(width * 0.115),
        outline=(255, 255, 255, 60), width=2)
    # Re-clip bottom square (bleeds off the canvas anyway) and tilt.
    margin = width // 2
    canvas = Image.new("RGBA", (body.width + margin * 2, body.height + margin * 2), (0, 0, 0, 0))
    canvas.alpha_composite(body, (margin, margin))
    canvas = canvas.rotate(angle, resample=Image.BICUBIC, expand=True)
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow.putalpha(canvas.getchannel("A").point(lambda a: int(a * 0.55)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(width * 0.07))
    shadow = ImageChops.offset(shadow, int(width * 0.02), int(width * 0.06))
    shadow = Image.merge("RGBA", (*Image.new("RGB", canvas.size, (12, 14, 60)).split(), shadow.getchannel("A")))
    out = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    out.alpha_composite(shadow)
    out.alpha_composite(canvas)
    return out


# ---------------------------------------------------------------- compositions

def render(w: int, h: int, headline: str, shot: Image.Image, kicker: str,
           sub: str | None = None, angle: float = -5.0, grain: int = 7) -> Image.Image:
    s = h / 900
    img = background(w, h, grain).convert("RGBA")
    d = ImageDraw.Draw(img)
    left = round(w * 0.0625)

    # Phone first so text sits above any shadow overlap.
    pw = round(w * 0.30)
    ph = phone(shot, pw, angle)
    _paste_clipped(img, ph, round(w * 0.635) - (ph.width - pw) // 2, round(h * 0.10) - (ph.width - pw) // 2)

    mark(img, left, round(62 * s), round(68 * s))

    text_w = w * 0.57 - left
    top = 190 * s
    bottom = h - 120 * s
    kf = font("Bold", 24 * s)
    kick = kicker.upper()
    kw = d.textlength(kick, font=kf) + 40 * s
    ky = top
    pill = Image.new("RGBA", img.size, (0, 0, 0, 0))   # translucent, so composite rather than draw
    ImageDraw.Draw(pill).rounded_rectangle([left, ky, left + kw, ky + 48 * s], radius=int(24 * s),
                                           fill=(255, 255, 255, 38), outline=(255, 255, 255, 90),
                                           width=max(1, int(2 * s)))
    img.alpha_composite(pill)
    d = ImageDraw.Draw(img)
    d.text((left + kw / 2, ky + 24 * s + 1), kick, font=kf, fill="white", anchor="mm")

    sub_h = 0
    sf = font("SemiBold", 34 * s)
    sub_lines: list[str] = []
    if sub:
        sub_lines = wrap(d, sub, sf, text_w)[:3]
        sub_h = len(sub_lines) * 46 * s + 30 * s
    tf, lines, size = fit_title(d, headline, text_w, bottom - (ky + 48 * s + 36 * s) - sub_h - 40 * s, int(88 * s))
    y = ky + 48 * s + 36 * s
    for line in lines:
        d.text((left, y), line, font=tf, fill="white")
        y += size * 1.12
    y += 34 * s
    for line in sub_lines:
        d.text((left, y), line, font=sf, fill=(232, 234, 255, 235))
        y += 46 * s

    uf = font("SemiBold", 25 * s)
    d.text((left, h - 66 * s), SITE_URL, font=uf, fill=(255, 255, 255, 200), anchor="lm")
    return img.convert("RGB")


def _paste_clipped(img: Image.Image, layer: Image.Image, x: int, y: int) -> None:
    img.alpha_composite(layer.crop((max(0, -x), max(0, -y),
                                    min(layer.width, img.width - x), min(layer.height, img.height - y))),
                        (max(x, 0), max(y, 0)))


def save_webp(img: Image.Image, path: Path, limit: int) -> None:
    for q in (86, 80, 74, 68, 60, 50):
        img.save(path, "WEBP", quality=q, method=6)
        if path.stat().st_size <= limit:
            return


def save_png(img: Image.Image, path: Path, limit: int = 300_000) -> None:
    """Full-colour first; if it is too heavy, quantise (the grain makes plain PNG ~1 MB)."""
    for colors in (256, 192, 128, 96, 64):
        q = img.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG)
        q.save(path, "PNG", optimize=True)
        if path.stat().st_size <= limit:
            return


# ---------------------------------------------------------------- posts

def parse_front_matter(raw: str) -> dict[str, str]:
    lines = raw.lstrip("﻿").splitlines()
    meta: dict[str, str] = {}
    if not lines or lines[0].strip() != "---":
        return meta
    for line in lines[1:]:
        if line.strip() == "---":
            break
        key, sep, value = line.partition(":")
        if sep:
            v = value.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            meta[key.strip().lower()] = v
    return meta


def make_covers(content: Path, out: Path) -> list[Path]:
    written = []
    (out / "blog").mkdir(parents=True, exist_ok=True)
    for md in sorted(content.glob("*.md")):
        meta = parse_front_matter(md.read_text(encoding="utf-8"))
        cover = meta.get("cover")
        if not cover:
            continue
        shot_name = meta.get("shot") or DEFAULT_SHOT
        if not (out / "shots" / f"{shot_name}.webp").exists():
            shot_name = DEFAULT_SHOT
        shot = load_shot(out, shot_name)
        title = meta.get("title", md.stem)
        big = render(1600, 900, title, shot, "Blog")
        p = out / "blog" / f"{cover}.webp"
        save_webp(big, p, 240_000)
        written.append(p)
        og = render(1200, 630, title, shot, "Blog", grain=0)
        p = out / "blog" / f"{cover}-og.png"
        save_png(og, p)
        written.append(p)
    return written


def make_default_og(out: Path) -> Path:
    img = render(1200, 630, "Meeting notes that never leave your phone", load_shot(out, DEFAULT_SHOT),
                 "On-device", grain=0, sub="Recorded, transcribed and written on the device.")
    p = out / "og.png"
    save_png(img, p)
    return p


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--content", type=Path, default=SERVER / "app" / "content" / "blog")
    ap.add_argument("--out", type=Path, default=SERVER / "app" / "static")
    a = ap.parse_args(argv)
    paths = make_shots(a.out) + make_covers(a.content, a.out) + [make_default_og(a.out)]
    for p in paths:
        print(f"wrote {p} ({p.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
