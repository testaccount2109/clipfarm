"""Generate the Windows icon for Spool from the project's simple reel mark."""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path


SIZE = 64
SCALE = 4
BACKGROUND = (17, 22, 23, 255)
ACCENT = (194, 123, 72, 255)
ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "Spool.App" / "Assets" / "spool.ico"


def inside_rounded_rect(x: float, y: float, width: float, height: float, radius: float) -> bool:
    cx = min(max(x, radius), width - radius)
    cy = min(max(y, radius), height - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2


def sample(x: float, y: float) -> tuple[int, int, int, int]:
    if not inside_rounded_rect(x, y, SIZE, SIZE, 15):
        return (0, 0, 0, 0)

    color = BACKGROUND
    center_x, center_y = 25.0, 32.0
    radius = math.hypot(x - center_x, y - center_y)
    on_reel = 16.5 <= radius <= 21.0
    on_tail = 27.0 <= x <= 55.0 and abs(y - 32.0) <= 2.7
    on_center = 4.0 <= radius <= 7.0
    if on_reel or on_tail or on_center:
        color = ACCENT
    if radius < 4.0:
        color = BACKGROUND
    return color


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def main() -> None:
    rows = bytearray()
    for y in range(SIZE):
        rows.append(0)
        for x in range(SIZE):
            samples = [sample(x + (sx + 0.5) / SCALE, y + (sy + 0.5) / SCALE) for sy in range(SCALE) for sx in range(SCALE)]
            rows.extend(round(sum(pixel[channel] for pixel in samples) / len(samples)) for channel in range(4))

    png = b"\x89PNG\r\n\x1a\n"
    png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += png_chunk(b"IDAT", zlib.compress(bytes(rows), 9))
    png += png_chunk(b"IEND", b"")

    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(header + entry + png)
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()
