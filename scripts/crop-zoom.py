"""把截图裁成局部放大，方便肉眼看细节（2026-11-10）。

为什么需要：整页缩到 1030px 宽后，12px 的字、1px 的边线、卡片间距
都看不清，容易把「有点挤」错判成「没问题」。裁局部再放大才能判断。

用法：
  python scripts/crop-zoom.py <png> <x> <y> <w> <h> [倍数] [输出名]
坐标按**原图**像素（截图是 2x DPR，2091x1259）。
"""

import sys
from pathlib import Path
from PIL import Image

def main():
    if len(sys.argv) < 6:
        print(__doc__)
        return 2
    src = Path(sys.argv[1])
    x, y, w, h = (int(v) for v in sys.argv[2:6])
    scale = float(sys.argv[6]) if len(sys.argv) > 6 else 2.0
    out = Path(sys.argv[7]) if len(sys.argv) > 7 else src.with_name(src.stem + f'-crop.png')

    im = Image.open(src)
    box = (max(0, x), max(0, y), min(im.width, x + w), min(im.height, y + h))
    part = im.crop(box)
    if scale != 1:
        part = part.resize((int(part.width * scale), int(part.height * scale)), Image.LANCZOS)
    out.parent.mkdir(parents=True, exist_ok=True)
    part.save(out)
    print(f'{out}  {part.width}x{part.height}  源区域={box}')
    return 0

if __name__ == '__main__':
    sys.exit(main())
