#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成扩展图标（纯标准库，无 Pillow 依赖）。

图形直接采用觅图 Mito 的品牌标记「取景框」（viewfinder）：
四个圆角 L 形角标 + 一圈对焦环 + 中心实心点。
与觅图主站 web/brand/01-viewfinder.svg 同一套几何，
所以插件图标与觅图系统放在一起时是同一套视觉语言。

实现说明：原 SVG 用 stroke 描边（圆头圆角），纯 Python 逐像素不好直接描边。
这里把圆头线段拆成「胶囊形状」（线段 + 两端半径为半线宽的圆），
再把 L 形两条胶囊的并集算出来 —— 与 SVG 的 stroke-linecap="round" +
stroke-linejoin="round" 视觉等价。

配色沿用觅图主站的深色底 + 取景框反白：
  底色 #14171C（觅图 brand ink），标记 #FFFFFF
16px 下角标与对焦环会粘连，所以小尺寸省略对焦环、只留角标与中心点。

用法：
    python tools/make_icons.py
"""

import math
import os
import struct
import zlib

SIZES = [16, 32, 48, 128]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "icons")

# 觅图品牌色：brand ink（底）+ 反白（标记）
INK = (0x14, 0x17, 0x1C)
MARK = (0xFF, 0xFF, 0xFF)

RING_R = 20           # 对焦环半径
PAD = 21              # 角标起点距画布边

# 每个尺寸一套笔画参数（120 单位坐标系）。
# 小尺寸下按原比例画会糊成一团 —— 9/120 的线宽在 16px 上只有 1.2px，
# 抗锯齿一糊就看不出是取景框。所以按尺寸加粗笔画、缩短角标。
PRESETS = {
    16: {"sw": 14, "len": 25, "dot": 11, "ring_sw": 0},
    32: {"sw": 11, "len": 26, "dot": 9, "ring_sw": 8},
    48: {"sw": 9, "len": 26, "dot": 8, "ring_sw": 6},
    128: {"sw": 9, "len": 26, "dot": 8, "ring_sw": 6},
}


# ---------------- PNG ----------------

def _chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path, w, h, pixels):
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter type None
        raw += pixels[y * stride:(y + 1) * stride]
    data = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", data) + _chunk(b"IEND", b""))


# ---------------- 形状（全部在 0..1 单位坐标系里判定） ----------------

def in_round_rect(x, y, x0, y0, x1, y1, r):
    """任意矩形 + 圆角"""
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r + 1e-9


def dist_to_segment(px, py, x1, y1, x2, y2):
    """点到线段的最短距离"""
    dx = x2 - x1
    dy = y2 - y1
    L2 = dx * dx + dy * dy
    if L2 <= 1e-12:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def in_capsule(x, y, x1, y1, x2, y2, r):
    """圆头线段（胶囊）"""
    return dist_to_segment(x, y, x1, y1, x2, y2) <= r


def in_ring(x, y, cx, cy, radius, half_sw):
    """圆环（描边圆）"""
    d = math.hypot(x - cx, y - cy)
    return abs(d - radius) <= half_sw


def in_dot(x, y, cx, cy, radius):
    return math.hypot(x - cx, y - cy) <= radius


def corner_brackets(x, y, unit, half_sw, length):
    """四个取景角标。

    每个角由两条胶囊组成（横臂 + 竖臂），两者在拐角处自然形成圆角接缝。
    """
    p = PAD * unit
    L = length * unit
    r = half_sw
    # 四个角：(拐点方向)  —— 用统一的 12 边界表达
    # 左上角：竖臂 (p, p+L)->(p, p)，横臂 (p, p)->(p+L, p)
    if in_capsule(x, y, p, p + L, p, p, r):
        return True
    if in_capsule(x, y, p, p, p + L, p, r):
        return True
    # 右上角：横臂 (p+L, p)->(1-p, p)，竖臂 (1-p, p)->(1-p, p+L)
    if in_capsule(x, y, p + L, p, 1 - p, p, r):
        return True
    if in_capsule(x, y, 1 - p, p, 1 - p, p + L, r):
        return True
    # 右下角：竖臂 (1-p, 1-p-L)->(1-p, 1-p)，横臂 (1-p, 1-p)->(1-p-L, 1-p)
    if in_capsule(x, y, 1 - p, 1 - p - L, 1 - p, 1 - p, r):
        return True
    if in_capsule(x, y, 1 - p, 1 - p, 1 - p - L, 1 - p, r):
        return True
    # 左下角：横臂 (1-p-L, 1-p)->(p, 1-p)，竖臂 (p, 1-p)->(p, 1-p-L)
    if in_capsule(x, y, 1 - p - L, 1 - p, p, 1 - p, r):
        return True
    if in_capsule(x, y, p, 1 - p, p, 1 - p - L, r):
        return True
    return False


def render(size, ss):
    """ss = 每边超采样倍数"""
    w = h = size
    buf = bytearray(w * h * 4)
    step = 1.0 / (size * ss)

    unit = 1.0 / 120.0     # 原 SVG 是 120x120
    p = PRESETS[size]
    half_sw = (p["sw"] * unit) / 2.0
    ring_r = RING_R * unit
    ring_half = (p["ring_sw"] * unit) / 2.0
    dot_r = p["dot"] * unit

    # 小尺寸省略对焦环：16px 下它会与角标粘连成一团糊
    with_ring = p["ring_sw"] > 0

    r = 0.225             # 圆角底板半径

    for py in range(h):
        for px in range(w):
            acc = [0.0, 0.0, 0.0, 0.0]
            n = ss * ss
            for sy in range(ss):
                for sx in range(ss):
                    x = (px * ss + sx + 0.5) * step
                    y = (py * ss + sy + 0.5) * step
                    if not in_round_rect(x, y, 0.0, 0.0, 1.0, 1.0, r):
                        continue
                    if corner_brackets(x, y, unit, half_sw, p["len"]):
                        col = MARK
                    elif with_ring and in_ring(x, y, 0.5, 0.5, ring_r, ring_half):
                        col = MARK
                    elif in_dot(x, y, 0.5, 0.5, dot_r):
                        col = MARK
                    else:
                        col = INK
                    acc[0] += col[0]
                    acc[1] += col[1]
                    acc[2] += col[2]
                    acc[3] += 255.0
            o = (py * w + px) * 4
            if acc[3] <= 0:
                buf[o:o + 4] = b"\x00\x00\x00\x00"
            else:
                a = acc[3] / n
                cover = acc[3] / 255.0
                buf[o] = int(round(acc[0] / cover))
                buf[o + 1] = int(round(acc[1] / cover))
                buf[o + 2] = int(round(acc[2] / cover))
                buf[o + 3] = int(round(a))
    return bytes(buf)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        ss = 8 if size <= 32 else 4
        px = render(size, ss)
        path = os.path.normpath(os.path.join(OUT, f"{size}.png"))
        write_png(path, size, size, px)
        print(f"生成 {path} ({os.path.getsize(path)} 字节)")


if __name__ == "__main__":
    main()
