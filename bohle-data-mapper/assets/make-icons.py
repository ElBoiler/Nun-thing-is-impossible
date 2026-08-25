#!/usr/bin/env python3
"""Render the extension icons.

The mark is deliberately abstract — layered shells around a pipe core, the
thing the company actually insulates — because the official Bohle logo files
are not in this repository. Drop the real assets in and delete this script when
they arrive (see BRANDING.md).

    python3 assets/make-icons.py
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Keep these in sync with src/branding/brand.css
NAVY = (11, 42, 74)
ACCENT = (75, 155, 213)
ACCENT_LIGHT = (127, 196, 234)
CORE = (240, 248, 253)

SUPERSAMPLE = 4


def rounded_rect(x: float, y: float, radius: float) -> bool:
    """Inside a 0..1 square with rounded corners of `radius`?"""
    cx = min(max(x, radius), 1 - radius)
    cy = min(max(y, radius), 1 - radius)
    return math.hypot(x - cx, y - cy) <= radius


def shell(x: float, y: float, inner: float, outer: float, gap_degrees: float) -> bool:
    """Inside an open ring centred on (0.5, 0.5), with a gap facing right?"""
    dx, dy = x - 0.5, y - 0.5
    distance = math.hypot(dx, dy)
    if not inner <= distance <= outer:
        return False
    angle = math.degrees(math.atan2(-dy, dx))
    return abs(angle) > gap_degrees / 2


def sample(x: float, y: float):
    if not rounded_rect(x, y, 0.22):
        return None
    if math.hypot(x - 0.5, y - 0.5) <= 0.115:
        return CORE
    if shell(x, y, 0.185, 0.255, 46):
        return ACCENT_LIGHT
    if shell(x, y, 0.300, 0.375, 46):
        return ACCENT
    return NAVY


def render(size: int) -> bytes:
    rows = []
    step = 1.0 / (size * SUPERSAMPLE)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = (px * SUPERSAMPLE + sx + 0.5) * step
                    y = (py * SUPERSAMPLE + sy + 0.5) * step
                    colour = sample(x, y)
                    if colour is not None:
                        r += colour[0]
                        g += colour[1]
                        b += colour[2]
                        a += 255
            total = SUPERSAMPLE * SUPERSAMPLE
            if a == 0:
                row += bytes(4)
            else:
                covered = a / 255
                row += bytes((round(r / covered), round(g / covered), round(b / covered), round(a / total)))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    for size in (16, 32, 48, 128):
        path = HERE / f"icon-{size}.png"
        path.write_bytes(render(size))
        print(f"assets/{path.name}  {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
