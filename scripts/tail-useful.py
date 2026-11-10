"""从庞大的构建日志里挑出有用的行（2026-11-10）。

electron-builder 的失败输出里混着几十 KB 的空白与重复栈帧，
直接 grep 很难看清。这里按「有意义的行」过滤：
非空、且不是纯空白/纯栈帧。

用法：python scripts/tail-useful.py <logfile> [条数]
"""

import sys
import re
from pathlib import Path

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    src = Path(sys.argv[1])
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 60

    if not src.exists():
        print(f'找不到 {src}')
        return 2

    text = src.read_text(encoding='utf-8', errors='replace')

    # 按行切，去掉首尾空白后只保留有内容的
    lines = []
    for raw in text.split('\n'):
        s = raw.strip()
        if not s:
            continue
        # 折叠超长行（某些错误把整个 JSON 打在一行）
        if len(s) > 400:
            s = s[:400] + ' …[截断]'
        lines.append(s)

    # 去重相邻重复（大量重复的栈帧）
    dedup = []
    for s in lines:
        if dedup and dedup[-1] == s:
            continue
        dedup.append(s)

    print(f'总行数 {len(lines)}，去重后 {len(dedup)}\n')
    print('=== 末尾 %d 行 ===' % limit)
    for s in dedup[-limit:]:
        print(s)
    return 0

if __name__ == '__main__':
    sys.exit(main())
