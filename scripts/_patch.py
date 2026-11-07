"""
按行尾自适应做文本替换的小工具。

## 为什么需要它

这个仓库里同一批文件混用 CRLF 与 LF（用户交接文档里专门警告过）：
  - src/v2/ui/App.tsx                 CRLF
  - src/core/questions/service.ts     CRLF
  - src/v2/ui/GeneratePage.tsx        CRLF/LF 混用
  - src/v2/ui/ReviewPage.tsx          LF
  - src/v2/ui/PracticePage.tsx        LF（新建）

用 Python 以默认 text 模式读入会把 CRLF 归一成 \n，
于是「按原文片段做替换」全部匹配失败 —— 这不是代码错，是读写方式错。

这个模块统一：以 newline='' 读写（保留原样），
替换时把模式里的 \n 自动展开成该文件实际用的行尾。
替换完成后校验行尾计数没有漂移。

用法：
    from _patch import patch_file
    patch_file('src/v2/ui/App.tsx', [
        ('旧片段', '新片段'),
    ])
"""

import io


def _detect_eol(text: str) -> str:
    """判断文件主要用哪种行尾。混用时以 CRLF 为准（本项目多数是 CRLF）。"""
    crlf = text.count('\r\n')
    bare_lf = text.count('\n') - crlf
    return '\r\n' if crlf >= bare_lf else '\n'


def patch_file(path: str, pairs, expect_once: bool = True) -> None:
    """
    对文件做若干次字面替换。

    pairs: [(old, new), ...]，old/new 里用普通 \n 书写，
           函数内部会按文件实际行尾展开。
    """
    with io.open(path, encoding='utf-8', newline='') as f:
        text = f.read()

    eol = _detect_eol(text)
    before_crlf = text.count('\r\n')
    before_lf = text.count('\n') - before_crlf

    for old, new in pairs:
        old_e = old.replace('\n', eol)
        new_e = new.replace('\n', eol)
        count = text.count(old_e)
        if count == 0:
            raise SystemExit(f'[patch] 找不到片段（文件 {path}，行尾 {"CRLF" if eol == chr(13)+chr(10) else "LF"}）：\n{old[:200]}')
        if expect_once and count > 1:
            raise SystemExit(f'[patch] 片段出现 {count} 次，无法确定改哪一处：\n{old[:200]}')
        text = text.replace(old_e, new_e, 1)

    after_crlf = text.count('\r\n')
    after_lf = text.count('\n') - after_crlf

    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)

    print(f'[patch] {path}  ok  (CRLF {before_crlf}->{after_crlf}, bareLF {before_lf}->{after_lf})')
