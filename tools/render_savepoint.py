#!/usr/bin/env python3
"""Pre-renders the spinning save point shown by the setup screens.

Handhelds cannot rasterise an 80k-triangle mesh in Python at frame rate, so the rotation is baked
into a sprite strip (FRAMES frames side by side, transparent background) that the apps just blit.

Model: "Save Point" by FFVII-Collector, https://www.thingiverse.com/thing:3485640 (CC BY).
Usage: render_savepoint.py model.stl out.png [size] [frames]
"""
import math
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def load_stl(path):
    with open(path, "rb") as f:
        f.read(80)
        n = struct.unpack("<I", f.read(4))[0]
        data = np.frombuffer(f.read(n * 50), dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    return data["v"].astype(np.float64)


def render(tris, size, angle, light=np.array([0.4, 0.7, 0.6])):
    c, s = math.cos(angle), math.sin(angle)
    rot = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])  # spin around the vertical axis
    tilt = math.radians(-12)
    rx = np.array([[1, 0, 0], [0, math.cos(tilt), -math.sin(tilt)], [0, math.sin(tilt), math.cos(tilt)]])
    v = tris @ (rx @ rot).T
    normals = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    lens = np.linalg.norm(normals, axis=1)
    keep = lens > 0
    v, normals = v[keep], normals[keep] / lens[keep, None]
    facing = normals[:, 2] > 0
    v, normals = v[facing], normals[facing]
    shade = np.clip(normals @ (light / np.linalg.norm(light)), 0, 1)
    order = np.argsort(v[:, :, 2].mean(axis=1))  # painter's algorithm: far to near
    pad = size * 0.1
    xy = v[:, :, :2]
    img = Image.new("RGBA", (size * 2, size * 2), (0, 0, 0, 0))  # 2x supersampling
    draw = ImageDraw.Draw(img)
    scale = (size * 2 - 4 * pad) / 2
    # Crystal look: deep teal in shadow to pale cyan in light, a touch of green with height
    ymin, ymax = tris[:, :, 1].min(), tris[:, :, 1].max()
    for i in order:
        t = shade[i]
        h = (v[i, :, 1].mean() - ymin) / (ymax - ymin)
        r = int(40 + 150 * t * (0.6 + 0.4 * h))
        g = int(150 + 100 * t)
        b = int(140 + 110 * t * (1 - 0.3 * h))
        pts = [(size + p[0] * scale, size - p[1] * scale) for p in xy[i]]
        draw.polygon(pts, fill=(r, g, b, 255))
    img = img.resize((size, size), Image.LANCZOS)
    glow = img.filter(ImageFilter.GaussianBlur(size / 18))
    glow.putalpha(glow.getchannel("A").point(lambda a: a * 0.6))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.alpha_composite(glow)
    out.alpha_composite(img)
    return out


def main():
    stl, dest = sys.argv[1], sys.argv[2]
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 160
    frames = int(sys.argv[4]) if len(sys.argv) > 4 else 36
    tris = load_stl(stl)
    # Centre and normalise; STL from 3D printing is Z-up, the screen is Y-up
    tris = tris[:, :, [0, 2, 1]]
    centre = (tris.reshape(-1, 3).max(axis=0) + tris.reshape(-1, 3).min(axis=0)) / 2
    tris -= centre
    tris /= np.abs(tris).max()
    strip = Image.new("RGBA", (size * frames, size), (0, 0, 0, 0))
    for k in range(frames):
        strip.paste(render(tris, size, 2 * math.pi * k / frames), (k * size, 0))
        print(f"frame {k + 1}/{frames}", end="\r", flush=True)
    strip.save(dest, optimize=True)
    print(f"\nsaved {dest}")


if __name__ == "__main__":
    main()
