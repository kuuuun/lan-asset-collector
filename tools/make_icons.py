#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成扩展图标（纯标准库，无 Pillow 依赖）。

图形含义：一张照片卡 + 自上而下的箭头 = 「把这张图片收进库里」。
底色用靛蓝→青的斜向渐变，和设置页 / 弹窗的主色同族。

小尺寸（16/32）会省略卡片内部的山与太阳：16px 下那点细节只会糊成噪点，
留一张干净的白卡片反而更像「图片」。这是图标设计的常规做法 —— 按尺寸给细节。

用法：
    python tools/make_icons.py
"""

import os
import struct
import zlib

SIZES = [16, 32, 48, 128]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "icons")

# 渐变两端：靛蓝 → 天青
C1 = (99, 102, 241)
C2 = (14, 165, 233)


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


def in_arrow(x, y, small=False):
    """自上而下的箭头：箭杆 + 三角头。

    small=True 是给 16/32 用的加粗版 —— 小尺寸下细杆细头会被抗锯齿糊掉，
    必须把笔画加宽才看得出来。
    """
    if small:
        shaft_half, shaft_y, head_y, head_half = 0.09, (0.085, 0.22), (0.20, 0.42), 0.26
    else:
        shaft_half, shaft_y, head_y, head_half = 0.063, (0.10, 0.25), (0.22, 0.38), 0.205
    if abs(x - 0.5) <= shaft_half and shaft_y[0] <= y <= shaft_y[1]:
        return True
    if head_y[0] <= y <= head_y[1]:
        t = (y - head_y[0]) / (head_y[1] - head_y[0])
        if abs(x - 0.5) <= head_half * (1.0 - t):
            return True
    return False


def in_card(x, y, small=False):
    """照片卡（白色主体）"""
    if small:
        return in_round_rect(x, y, 0.115, 0.50, 0.885, 0.915, 0.085)
    return in_round_rect(x, y, 0.13, 0.46, 0.87, 0.885, 0.09)


def in_card_detail(x, y):
    """卡片内部被镂空的部分（山 + 太阳），镂空后透出底色"""
    # 太阳
    dx = x - 0.305
    dy = y - 0.585
    if dx * dx + dy * dy <= 0.05 * 0.05:
        return True
    # 近处的山（上尖下宽）
    if 0.575 <= y <= 0.80:
        t = (y - 0.575) / 0.225
        if abs(x - 0.615) <= 0.235 * t:
            return True
    # 远处的山
    if 0.635 <= y <= 0.80:
        t = (y - 0.635) / 0.165
        if abs(x - 0.345) <= 0.135 * t:
            return True
    return False


def render(size, ss):
    """ss = 每边超采样倍数"""
    w = h = size
    buf = bytearray(w * h * 4)
    step = 1.0 / (size * ss)
    r = 0.225
    small = size < 48  # 小尺寸：加粗笔画、省掉卡片内部细节

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
                    t = max(0.0, min(1.0, x * 0.55 + y * 0.45))
                    base = (
                        C1[0] + (C2[0] - C1[0]) * t,
                        C1[1] + (C2[1] - C1[1]) * t,
                        C1[2] + (C2[2] - C1[2]) * t,
                    )
                    if in_arrow(x, y, small):
                        col = (255.0, 255.0, 255.0)
                    elif in_card(x, y, small):
                        col = base if (not small and in_card_detail(x, y)) else (255.0, 255.0, 255.0)
                    else:
                        col = base
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
