#!/usr/bin/env python3
"""用 python-pptx（独立于 pptxgenjs 的另一套 OOXML 实现）核对导出的 .pptx。

为什么需要这个脚本：我们自己写的单测是「解压 zip → 正则找 <a:t>」，
那只证明字节里出现过某段文字，不证明**别的软件读得懂**。计划书的验收
第一条是「在 Office 和 WPS 里都能正常打开、不乱版、文字可编辑」，本机
没有 Office，用 python-pptx 打开是最接近的替代：它按 OOXML 规范解析
版式、形状树、文本 run，读不出来就说明我们生成的结构有问题。

用法：
    python scripts/inspect-pptx.py <file.pptx> [--json]

退出码：0 = 全部检查通过；1 = 有硬性失败（打不开 / 无文字 / 越界溢出）
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from pptx import Presentation
    from pptx.util import Emu
except ImportError:  # pragma: no cover
    print("缺少 python-pptx，请先安装：pip install python-pptx", file=sys.stderr)
    sys.exit(2)

# 形状超出幻灯片边界多少算「溢出」：留 1% 容差，规避浮点换算误差。
OVERFLOW_TOLERANCE = 0.01


def emu_to_inch(value: int | None) -> float | None:
    if value is None:
        return None
    return round(Emu(value).inches, 3)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--json", action="store_true", help="输出 JSON 而不是人读摘要")
    parser.add_argument(
        "--expect-slides", type=int, default=None, help="断言页数等于该值"
    )
    args = parser.parse_args()

    path = Path(args.path)
    if not path.exists():
        print(f"文件不存在：{path}", file=sys.stderr)
        return 1

    # 第一道关：能不能被另一套实现打开。
    try:
        prs = Presentation(str(path))
    except Exception as exc:  # noqa: BLE001 - 目的就是把异常原样报出来
        print(f"打不开（OOXML 结构有问题）：{exc}", file=sys.stderr)
        return 1

    slide_w = emu_to_inch(prs.slide_width)
    slide_h = emu_to_inch(prs.slide_height)

    slides = []
    overflow_shapes = []
    empty_slides = []
    superscript_runs = 0
    citation_texts = []

    for index, slide in enumerate(prs.slides, start=1):
        texts = []
        shape_reports = []
        for shape in slide.shapes:
            text = ""
            if shape.has_text_frame:
                text = "\n".join(p.text for p in shape.text_frame.paragraphs).strip()
                # 角标是用 superscript 的 run 做的：数一数真的存在
                for para in shape.text_frame.paragraphs:
                    for run in para.runs:
                        # python-pptx 没直接暴露 baseline，读底层 rPr
                        rpr = run._r.find(
                            "{http://schemas.openxmlformats.org/drawingml/2006/main}rPr"
                        )
                        if rpr is not None and rpr.get("baseline") not in (None, "0"):
                            superscript_runs += 1
            if text:
                texts.append(text)
                if "[" in text and "]" in text:
                    citation_texts.append(text)

            left = emu_to_inch(shape.left)
            top = emu_to_inch(shape.top)
            width = emu_to_inch(shape.width)
            height = emu_to_inch(shape.height)

            # 越界检查：幻灯片外面的内容在 Office/WPS 里就是看不见的
            if None not in (left, top, width, height):
                overflow_x = left < -OVERFLOW_TOLERANCE or (
                    left + width > slide_w + OVERFLOW_TOLERANCE
                )
                overflow_y = top < -OVERFLOW_TOLERANCE or (
                    top + height > slide_h + OVERFLOW_TOLERANCE
                )
                if overflow_x or overflow_y:
                    overflow_shapes.append(
                        {
                            "slide": index,
                            "shape": shape.shape_type,
                            "text": text[:40],
                            "box": [left, top, width, height],
                        }
                    )

            shape_reports.append(
                {
                    "type": str(shape.shape_type),
                    "has_text": bool(text),
                    "text_len": len(text),
                    "box": [left, top, width, height],
                }
            )

        joined = "\n".join(texts)
        if not joined.strip():
            empty_slides.append(index)

        slides.append(
            {
                "index": index,
                "shape_count": len(slide.shapes),
                "text_len": len(joined),
                "first_text": texts[0][:60] if texts else "",
                "texts": texts,
                "shapes": shape_reports,
            }
        )

    result = {
        "file": path.name,
        "byteSize": path.stat().st_size,
        "slideSize": [slide_w, slide_h],
        "slideCount": len(slides),
        "emptySlides": empty_slides,
        "overflowShapes": overflow_shapes,
        "superscriptRuns": superscript_runs,
        "slidesWithCitationMark": len(citation_texts),
        "slides": slides,
    }

    failures = []
    if not slides:
        failures.append("一页都没有")
    if empty_slides:
        failures.append(f"空白页：{empty_slides}")
    if overflow_shapes:
        failures.append(f"{len(overflow_shapes)} 个形状超出幻灯片边界")
    if args.expect_slides is not None and len(slides) != args.expect_slides:
        failures.append(f"页数 {len(slides)} ≠ 期望 {args.expect_slides}")

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"文件：{result['file']}（{result['byteSize']:,} bytes）")
        print(f"画面尺寸：{slide_w} × {slide_h} 英寸（16:9 应为 13.333 × 7.5）")
        print(f"页数：{len(slides)}")
        print(f"上标 run：{superscript_runs}（角标实现方式）")
        print(f"含 [n] 角标的页：{len(citation_texts)}")
        print(f"空白页：{empty_slides or '无'}")
        print(f"越界形状：{len(overflow_shapes)}")
        for item in overflow_shapes[:5]:
            print(f"  · 第 {item['slide']} 页 {item['box']} 「{item['text']}」")
        print()
        for slide in slides:
            texts = " / ".join(slide["texts"])[:78]
            print(f"  [{slide['index']:>2}] {slide['text_len']:>4} 字  {texts}")

    if failures:
        print("\n失败：" + "；".join(failures), file=sys.stderr)
        return 1
    print("\n全部检查通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
