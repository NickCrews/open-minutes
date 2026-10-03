#!/usr/bin/env python3
"""Regenerate the bitmap font in src/listen/font.ts (needs Pillow and DejaVu
Sans Mono). Prints the glyph size, the glyph count and the base64 bits."""
from PIL import Image, ImageDraw, ImageFont
import base64
f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 12)
W, H = 7, 14
chars = "".join(chr(c) for c in range(32, 127))
bits = []
for ch in chars:
    im = Image.new("L", (W, H), 0)
    ImageDraw.Draw(im).text((0, -1), ch, font=f, fill=255)
    for y in range(H):
        for x in range(W):
            bits.append(1 if im.getpixel((x, y)) >= 110 else 0)
by = bytearray()
for i in range(0, len(bits), 8):
    b = 0
    for j, v in enumerate(bits[i:i+8]): b |= v << (7 - j)
    by.append(b)
print(W, H, len(chars))
print(base64.b64encode(bytes(by)).decode())
