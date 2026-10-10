#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一个 PNG 放大到便于肉眼检查的尺寸（最近邻 + 棋盘底），输出到临时目录。

用途：16×16 的图标在编辑器里只有指甲盖大，看不出抗锯齿是否糊掉。
     python dev-tests/icon_preview.py assets/icons/16.png 16
只做只读检查，不碰 assets/ 里的成品；不进打包。
"""

import os
import struct
import sys
import zlib


def _chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(
        ">I", zlib.crc32(tag + data) & 0xFFFFFFFF
    )


def write_png(path, w, h, pixels):
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += pixels[y * stride:(y + 1) * stride]
    with open(path, "wb") as f:
        f.write(
            sig
            + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + _chunk(b"IEND", b"")
        )


def read_png(path):
    b = open(path, "rb").read()
    pos, w, h, idat = 8, None, None, b""
    while pos < len(b):
        ln = struct.unpack(">I", b[pos:pos + 4])[0]
        tag = b[pos + 4:pos + 8]
        data = b[pos + 8:pos + 8 + ln]
        if tag == b"IHDR":
            w, h = struct.unpack(">II", data[:8])
        elif tag == b"IDAT":
            idat += data
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * 4
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ft = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ft == 1:
            for i in range(4, stride):
                line[i] = (line[i] + line[i - 4]) & 255
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif ft == 3:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif ft == 4:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                c = prev[i - 4] if i >= 4 else 0
                bb = prev[i]
                pa, pb, pc = abs(bb - c), abs(a - c), abs(a + bb - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (bb if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, out


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "assets/icons/128.png"
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    w, h, px = read_png(src)
    W, H = w * k, h * k
    buf = bytearray(W * H * 4)
    for y in range(H):
        for x in range(W):
            o = ((y // k) * w + (x // k)) * 4
            r, g, b, a = px[o], px[o + 1], px[o + 2], px[o + 3]
            bg = 235 if (((x // 8) + (y // 8)) % 2 == 0) else 205
            al = a / 255.0
            oo = (y * W + x) * 4
            buf[oo] = int(r * al + bg * (1 - al))
            buf[oo + 1] = int(g * al + bg * (1 - al))
            buf[oo + 2] = int(b * al + bg * (1 - al))
            buf[oo + 3] = 255
    out = os.path.join(
        os.environ.get("TEMP", "/tmp"), "cc-icon-preview", "zoom-" + os.path.basename(src)
    )
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write_png(out, W, H, bytes(buf))
    print(f"{src} {w}x{h}  ->  {out} {W}x{H}")


if __name__ == "__main__":
    main()
