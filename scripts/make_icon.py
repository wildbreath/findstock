"""生成桌面快捷方式用的图标 (纯标准库, 无第三方依赖)。

用法::

    python -m scripts.make_icon

输出 ``assets/findstock.ico`` (多尺寸 32 位 BMP 条目)。
图案为蓝底 + 三根递增柱状图, 用 4 倍超采样保证小尺寸下边缘干净。
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = PROJECT_ROOT / "assets" / "findstock.ico"

SIZES = (16, 32, 48, 64, 128)
SUPERSAMPLE = 4

BACKGROUND = (37, 99, 235)  # #2563eb, 与前端主色一致
BAR_COLOR = (255, 255, 255)

CORNER_RADIUS = 0.22
BAR_WIDTH = 0.115
BAR_GAP = 0.055
BAR_HEIGHTS = (0.30, 0.46, 0.62)
BASELINE = 0.80


class Rgba:
    """极简 RGBA 画布。"""

    __slots__ = ("size", "pixels")

    def __init__(self, size: int) -> None:
        self.size = size
        self.pixels = [(0, 0, 0, 0)] * (size * size)

    def set(self, x: int, y: int, color: tuple[int, int, int, int]) -> None:
        self.pixels[y * self.size + x] = color


def _inside_rounded_rect(u: float, v: float, radius: float) -> bool:
    """单位正方形内的圆角矩形判定。"""

    dx = max(radius - u, u - (1.0 - radius), 0.0)
    dy = max(radius - v, v - (1.0 - radius), 0.0)
    return dx * dx + dy * dy <= radius * radius


def _inside_bars(u: float, v: float) -> bool:
    """三根递增柱: 返回是否落在柱体内。"""

    total = len(BAR_HEIGHTS) * BAR_WIDTH + (len(BAR_HEIGHTS) - 1) * BAR_GAP
    left = (1.0 - total) / 2.0
    for index, height in enumerate(BAR_HEIGHTS):
        x0 = left + index * (BAR_WIDTH + BAR_GAP)
        if x0 <= u <= x0 + BAR_WIDTH and BASELINE - height <= v <= BASELINE:
            return True
    return False


def render(size: int) -> Rgba:
    """渲染一个尺寸的图标 (超采样后降采样)。"""

    canvas = Rgba(size)
    scale = size * SUPERSAMPLE
    step = SUPERSAMPLE * SUPERSAMPLE

    colors = (BACKGROUND, BAR_COLOR)

    for y in range(size):
        for x in range(size):
            accum = [0, 0, 0, 0]
            for sy in range(SUPERSAMPLE):
                v = (y * SUPERSAMPLE + sy + 0.5) / scale
                for sx in range(SUPERSAMPLE):
                    u = (x * SUPERSAMPLE + sx + 0.5) / scale
                    if not _inside_rounded_rect(u, v, CORNER_RADIUS):
                        continue
                    rgb = colors[1] if _inside_bars(u, v) else colors[0]
                    accum[0] += rgb[0]
                    accum[1] += rgb[1]
                    accum[2] += rgb[2]
                    accum[3] += 255

            if accum[3] == 0:
                continue
            alpha = accum[3] // step
            # 颜色按覆盖到的样本数归一化, 保证边缘是纯色而不是渐暗。
            covered = accum[3] // 255
            canvas.set(
                x,
                y,
                (
                    accum[0] // covered,
                    accum[1] // covered,
                    accum[2] // covered,
                    alpha,
                ),
            )
    return canvas


def to_ico_entry(canvas: Rgba) -> bytes:
    """把画布编码为一个 32 位 BMP 图标条目。"""

    size = canvas.size
    header = struct.pack(
        "<IiiHHIIiiII",
        40,  # biSize
        size,  # biWidth
        size * 2,  # biHeight (XOR + AND 掩码)
        1,  # biPlanes
        32,  # biBitCount
        0,  # biCompression
        0,  # biSizeImage
        0,  # biXPelsPerMeter
        0,  # biYPelsPerMeter
        0,  # biClrUsed
        0,  # biClrImportant
    )

    xor = bytearray()
    for y in range(size - 1, -1, -1):  # BMP 自下而上
        for x in range(size):
            red, green, blue, alpha = canvas.pixels[y * size + x]
            xor += bytes((blue, green, red, alpha))

    mask_row_bytes = ((size + 31) // 32) * 4
    and_mask = bytes(mask_row_bytes * size)
    return header + bytes(xor) + and_mask


def build_ico(sizes: tuple[int, ...] = SIZES) -> bytes:
    """组装完整 ICO 文件内容。"""

    entries: list[tuple[int, bytes]] = [(size, to_ico_entry(render(size))) for size in sizes]

    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = len(header) + 16 * len(entries)

    directory = bytearray()
    payload = bytearray()
    for size, data in entries:
        directory += struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,
            0 if size >= 256 else size,
            0,
            0,
            1,
            32,
            len(data),
            offset,
        )
        payload += data
        offset += len(data)
    return bytes(header + directory + payload)


def main() -> int:
    """生成图标文件。"""

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_bytes(build_ico())
    print(f"已生成图标: {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size} 字节, 尺寸 {SIZES})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
