"""Console app icons from docs/logo.png in the "sticker" style of Onion's default theme: the drawing (it already
has its dark outline) on a white border that follows its shape, 74x74 with the drawing inside 64 px.

    python3 tools/sticker_icon.py OUT.png [SIZE] [BORDER_FRACTION]
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

SRC = 'docs/logo.png'
WHITE = (242, 242, 242)


def sticker(size=74, inner=64, border=4 / 64):
    scale = 8
    logo = Image.open(SRC).convert('RGBA')
    logo = logo.crop(logo.getbbox())
    box = inner * scale
    pad = round(box * border)
    fit = box - 2 * pad
    w, h = logo.size
    k = fit / max(w, h)
    logo = logo.resize((round(w * k), round(h * k)), Image.LANCZOS)
    canvas = Image.new('RGBA', (size * scale, size * scale), (0, 0, 0, 0))
    off = ((size * scale - logo.width) // 2, (size * scale - logo.height) // 2)
    canvas.alpha_composite(logo, off)
    alpha = np.asarray(canvas)[:, :, 3] > 64
    # A round white border: everything closer to the drawing than PAD, holes inside filled
    dist = ndimage.distance_transform_edt(~alpha)
    halo = ndimage.binary_fill_holes(dist <= pad)
    edge = np.clip(pad + 1 - dist, 0, 1) * 255
    white = np.zeros((size * scale, size * scale, 4), np.uint8)
    white[:, :, :3] = WHITE
    white[:, :, 3] = np.where(halo, np.maximum(edge, np.where(dist <= pad, 255, 0)), 0).astype(np.uint8)
    out = Image.fromarray(white, 'RGBA')
    out.alpha_composite(canvas)
    return out.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    target = sys.argv[1]
    size = int(sys.argv[2]) if len(sys.argv) > 2 else 74
    sticker(size, round(size * 64 / 74)).save(target, optimize=True)
