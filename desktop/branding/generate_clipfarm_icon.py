"""Generate the Windows icon from Clipfarm's three-bar mark."""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "clipfarm.ico"
BACKGROUND = (16, 19, 20, 255)
ACCENT = (220, 139, 66, 255)
SIZES = (16, 24, 32, 48, 64, 128, 256)
SCALE = 4


def inside_rounded_rect(x: float, y: float, left: float, top: float, right: float, bottom: float, radius: float) -> bool:
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2


def sample(x: float, y: float) -> tuple[int, int, int, int]:
    if not inside_rounded_rect(x, y, 5, 5, 59, 59, 15):
        return (0, 0, 0, 0)
    bars = ((18, 34, 26, 48), (28, 22, 36, 48), (38, 28, 46, 48))
    return ACCENT if any(left <= x <= right and top <= y <= bottom for left, top, right, bottom in bars) else BACKGROUND


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def make_png(size: int) -> bytes:
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            samples = [
                sample((x + (sx + 0.5) / SCALE) * 64 / size, (y + (sy + 0.5) / SCALE) * 64 / size)
                for sy in range(SCALE)
                for sx in range(SCALE)
            ]
            rows.extend(round(sum(pixel[channel] for pixel in samples) / len(samples)) for channel in range(4))

    png = b"\x89PNG\r\n\x1a\n"
    png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += png_chunk(b"IDAT", zlib.compress(bytes(rows), 9))
    return png + png_chunk(b"IEND", b"")


def main() -> None:
    images = [make_png(size) for size in SIZES]
    offset = 6 + 16 * len(images)
    entries = bytearray()
    for size, image in zip(SIZES, images):
        dimension = 0 if size == 256 else size
        entries.extend(struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(image), offset))
        offset += len(image)
    OUTPUT.write_bytes(struct.pack("<HHH", 0, 1, len(images)) + entries + b"".join(images))
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()
