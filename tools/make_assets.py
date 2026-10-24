"""Generate placeholder PNG tiles for the UWP package (stdlib only, no PIL)."""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'shell' / 'XboxShell' / 'Assets'
SIZES = {
    'StoreLogo.png': (50, 50),
    'Square44x44Logo.png': (44, 44),
    'Square150x150Logo.png': (150, 150),
    'Wide310x150Logo.png': (310, 150),
    'SplashScreen.png': (620, 300),
}


def png(w, h):
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            # dark background with a purple->blue diagonal glow, roughly Jellyfin-ish
            t = (x / max(w - 1, 1) + y / max(h - 1, 1)) / 2
            cx, cy = abs(x - w / 2) / (w / 2), abs(y - h / 2) / (h / 2)
            inside = max(cx, cy) < 0.45
            if inside:
                r, g, b = int(170 - 80 * t), int(92 + 40 * t), int(220 + 20 * t)
            else:
                r, g, b = 11, 11, 16
            row += bytes([r, g, b, 255])
        rows.append(bytes(row))
    raw = b''.join(rows)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


OUT.mkdir(parents=True, exist_ok=True)
for name, (w, h) in SIZES.items():
    (OUT / name).write_bytes(png(w, h))
    print(name, w, h)
