#!/usr/bin/env python3
"""
Draw the social card served as og:image.

    ./scripts/make-og-image.py

1200x630 is what Facebook, LinkedIn, Slack, WhatsApp and X all crop from, so it is the one size
worth having. Generated rather than exported from a design tool for the same reason the launcher
icons are: the mascot's geometry lives in one place (Mascot.tsx, mirrored into
assets/logo/ic_launcher_foreground.svg) and a second hand-drawn copy would drift from it.

Output: server/app/static/og.png, which the licence server serves and links from every page.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "server/app/static/og.png"
FONTS = ROOT / "assets/fonts"

W, H = 1200, 630
PRIMARY = (74, 86, 210)       # #4A56D2
PRIMARY_DEEP = (48, 58, 160)
INK = (22, 25, 44)            # #16192C
BLUSH = (255, 201, 206)       # #FFC9CE
CARD = (255, 255, 255)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    path = FONTS / name
    if not path.exists():
        raise SystemExit(f"missing font {path} — the repo's Nunito files are required")
    return ImageFont.truetype(str(path), size)


def mascot(draw: ImageDraw.ImageDraw, cx: float, cy: float, scale: float) -> None:
    """
    The same shapes as assets/logo/ic_launcher_foreground.svg, in the same order.

    Coordinates there are on a 120-unit grid centred near (60, 58); everything below is that grid
    mapped through (cx, cy, scale) so the proportions cannot drift from the launcher icon.
    """
    def at(x: float, y: float) -> tuple[float, float]:
        return cx + (x - 60) * scale, cy + (y - 60) * scale

    def circle(x: float, y: float, r: float, fill: tuple[int, int, int]) -> None:
        px, py = at(x, y)
        rr = r * scale
        draw.ellipse([px - rr, py - rr, px + rr, py + rr], fill=fill)

    def rounded(x: float, y: float, w: float, h: float, r: float, fill) -> None:
        x0, y0 = at(x, y)
        draw.rounded_rectangle([x0, y0, x0 + w * scale, y0 + h * scale],
                               radius=r * scale, fill=fill)

    circle(60, 58, 38, PRIMARY)                      # head
    rounded(12, 46, 18, 30, 9, PRIMARY_DEEP)         # left earcup
    rounded(90, 46, 18, 30, 9, PRIMARY_DEEP)         # right earcup
    # The headband: an arc, stroked rather than filled.
    x0, y0 = at(20, 10)
    x1, y1 = at(100, 90)
    draw.arc([x0, y0, x1, y1], start=180, end=360, fill=PRIMARY, width=int(7 * scale))
    circle(60, 63, 27, CARD)                         # face
    circle(51, 59, 4.6, INK)                         # eyes
    circle(69, 59, 4.6, INK)
    px, py = at(60, 73)                              # mouth
    draw.ellipse([px - 5 * scale, py - 6 * scale, px + 5 * scale, py + 6 * scale], fill=INK)
    circle(40, 68, 5, BLUSH)                         # cheeks
    circle(80, 68, 5, BLUSH)


def main() -> int:
    image = Image.new("RGB", (W, H), PRIMARY)
    draw = ImageDraw.Draw(image)

    # A vertical gradient, drawn a row at a time. Flat colour reads as a placeholder at this size.
    for y in range(H):
        t = y / H
        draw.line(
            [(0, y), (W, y)],
            fill=tuple(round(PRIMARY[i] + (PRIMARY_DEEP[i] - PRIMARY[i]) * t) for i in range(3)),
        )

    # The mascot sits on a white card, because its own body is the background colour.
    card = (90, 155, 90 + 320, 155 + 320)
    draw.rounded_rectangle(card, radius=76, fill=CARD)
    mascot(draw, cx=(card[0] + card[2]) / 2, cy=(card[1] + card[3]) / 2 + 6, scale=2.05)

    x = 470
    draw.text((x, 205), "Verbale", font=font("Nunito-ExtraBold.ttf", 112), fill=CARD)
    tagline = font("Nunito-SemiBold.ttf", 40)
    draw.text((x, 340), "Meeting notes that never", font=tagline, fill=(226, 229, 250))
    draw.text((x, 392), "leave your phone.", font=tagline, fill=(226, 229, 250))
    draw.text((x, 470), "Recorded, transcribed and written\non the device. Nothing uploaded.",
              font=font("Nunito-Regular.ttf", 27), fill=(186, 193, 238), spacing=10)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT.relative_to(ROOT)}  {W}x{H}  {OUT.stat().st_size / 1024:.0f} kB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
