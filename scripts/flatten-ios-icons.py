#!/usr/bin/env python3
"""Strip the alpha channel from the iOS app icons.

Inkscape always writes RGBA. An app icon that carries an alpha channel is rejected at submission
even when every one of its pixels is opaque, so the channel itself has to go — not just its
contents. Called by make-launcher-icons.sh; safe to re-run.
"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit('Pillow is needed to flatten the iOS icons: python3 -m pip install Pillow')


def main(directory: str) -> None:
    for name in sorted(os.listdir(directory)):
        if not name.endswith('.png'):
            continue
        path = os.path.join(directory, name)
        image = Image.open(path)
        if image.mode == 'RGB':
            continue
        # Composited onto white rather than simply dropped, so a partly transparent edge pixel
        # lands on the same background the artwork already uses instead of going black.
        flat = Image.new('RGB', image.size, (255, 255, 255))
        flat.paste(image, mask=image.split()[-1] if image.mode == 'RGBA' else None)
        flat.save(path)
        print(f'  flattened {name}')


if __name__ == '__main__':
    main(sys.argv[1])
