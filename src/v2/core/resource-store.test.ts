import { describe, expect, it } from 'vitest';
import {
  checkResourceUrl,
  deriveTitle,
  hostOf,
  isDuplicateUrl,
  makeResource,
  normalizeResources,
  relativeTime,
} from './resource-store.ts';

/**
 * 外部资源：网址校验与数据归一（2026-11-22，方案第 7 步）。
 *
 * ## 这组测试守的是**安全**，不是"好用"
 *
 * 方案 7.5 列的五种坏输入全部来自真实场景：
 * 用户从网页复制来的链接里真的有 `javascript:`（社工常用），
 * 也会有 `file:///C:/...`（把本机路径发给别人 = 泄露目录结构）。
 *
 * 所以每一条都要有测试，而且**反向验证**（放行它们 → 必须红）。
 */

describe('checkResourceUrl：坏输入必须被挡住', () => {
  it('⚠️ javascript: 被拒（可执行脚本，不是网页）', () => {
    const r = checkResourceUrl('javascript:alert(1)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('可执行脚本');
  });

  it('⚠️ file:// 被拒，且说清会暴露本机路径', () => {
    const r = checkResourceUrl('file:///C:/Users/ASUS/secret.docx');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('本机');
      expect(r.reason).toContain('目录结构');
    }
  });

  it('data: 被拒（可嵌脚本）', () => {
    expect(checkResourceUrl('data:text/html,<script>alert(1)</script>').ok).toBe(false);
  });

  it('其他奇怪协议被拒（ftp / mailto / 自定义 scheme）', () => {
    expect(checkResourceUrl('ftp://x.com/a').ok).toBe(false);
    expect(checkResourceUrl('mailto:a@b.com').ok).toBe(false);
    expect(checkResourceUrl('myapp://open').ok).toBe(false);
  });

  it('空输入被拒', () => {
    expect(checkResourceUrl('').ok).toBe(false);
    expect(checkResourceUrl('   ').ok).toBe(false);
  });

  it('完全不是网址被拒', () => {
    expect(checkResourceUrl('随便打的一串字').ok).toBe(false);
    expect(checkResourceUrl('hello world').ok).toBe(false);
  });

  it('⚠️ 单个词的主机名被拒（多半是打错，不是想访问 https://abc）', () => {
    const r = checkResourceUrl('https://abc');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不像一个完整域名');
  });
});

describe('checkResourceUrl：正常输入与自动补协议', () => {
  it('完整 https 原样通过', () => {
    const r = checkResourceUrl('https://www.bilibili.com/video/BV1xx');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toContain('bilibili.com');
      expect(r.addedScheme).toBe(false);
    }
  });

  it('⚠️ 无协议头自动补 https（方案明确要求）', () => {
    const r = checkResourceUrl('www.bilibili.com/x');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url.startsWith('https://')).toBe(true);
      expect(r.addedScheme).toBe(true);
    }
  });

  it('http 也放行（不强制 https —— 有些校内网只有 http）', () => {
    const r = checkResourceUrl('http://jw.example.edu.cn/course');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.startsWith('http://')).toBe(true);
  });

  it('⚠️ 前后空格被 trim（复制粘贴常见）', () => {
    const r = checkResourceUrl('  https://a.com/b  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://a.com/b');
  });

  it('本地地址放行（用户可能存本地起的服务）', () => {
    expect(checkResourceUrl('http://localhost:3000/a').ok).toBe(true);
    expect(checkResourceUrl('http://127.0.0.1:8080').ok).toBe(true);
  });

  it('IP 地址放行', () => {
    expect(checkResourceUrl('https://192.168.1.10/doc').ok).toBe(true);
  });

  it('带端口 / 查询串 / 锚点的保留', () => {
    const r = checkResourceUrl('https://a.com:8443/p?q=1#sec2');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toContain(':8443');
      expect(r.url).toContain('q=1');
      expect(r.url).toContain('#sec2');
    }
  });

  it('中文域名能通过（URL 会转 punycode）', () => {
    expect(checkResourceUrl('https://中文.com/a').ok).toBe(true);
  });
});

describe('deriveTitle：标题留空时的回退链', () => {
  it('给了抓到的标题 → 用它', () => {
    expect(deriveTitle('https://a.com/x', '线性代数第3讲')).toBe('线性代数第3讲');
  });

  it('没给标题 → 用域名（并去掉 www.）', () => {
    expect(deriveTitle('https://www.bilibili.com/video/BV1')).toBe('bilibili.com');
  });

  it('抓到的标题是空白 → 回退域名（不是空字符串）', () => {
    expect(deriveTitle('https://a.com/x', '   ')).toBe('a.com');
  });

  it('⚠️ 坏 URL 也不返回空（列表里不能有无标题项）', () => {
    const t = deriveTitle('not a url');
    expect(t.length).toBeGreaterThan(0);
  });

  it('标题截断到 120 字', () => {
    expect(deriveTitle('https://a.com', 'x'.repeat(300)).length).toBe(120);
  });
});

describe('isDuplicateUrl：同一个东西不该加两遍', () => {
  /**
   * 判据：忽略协议与末尾斜杠。
   * 用户粘贴 `http://b23.tv/x` 与已有的 `https://b23.tv/x/`，
   * 对他是同一个链接。
   */
  it('完全相同 → 重复', () => {
    expect(isDuplicateUrl('https://a.com/x', [{ url: 'https://a.com/x' }])).toBe(true);
  });

  it('⚠️ 只有协议不同 → 算重复', () => {
    expect(isDuplicateUrl('http://a.com/x', [{ url: 'https://a.com/x' }])).toBe(true);
  });

  it('⚠️ 末尾斜杠不同 → 算重复', () => {
    expect(isDuplicateUrl('https://a.com/x/', [{ url: 'https://a.com/x' }])).toBe(true);
  });

  it('www 前缀不同 → 算重复', () => {
    expect(isDuplicateUrl('https://www.a.com/x', [{ url: 'https://a.com/x' }])).toBe(true);
  });

  it('路径不同 → 不算重复', () => {
    expect(isDuplicateUrl('https://a.com/y', [{ url: 'https://a.com/x' }])).toBe(false);
  });

  it('空列表 → 不重复', () => {
    expect(isDuplicateUrl('https://a.com', [])).toBe(false);
  });
});

describe('makeResource', () => {
  it('造出一条完整资源', () => {
    const r = makeResource({
      sourceId: 'src-1',
      url: 'https://a.com/x',
      title: '甲',
      source: 'manual',
      now: '2026-11-22T10:00:00.000Z',
    });
    expect(r.id.startsWith('res_')).toBe(true);
    expect(r.title).toBe('甲');
    expect(r.source).toBe('manual');
    expect(r.addedAt).toBe('2026-11-22T10:00:00.000Z');
  });

  it('标题留空 → 用域名', () => {
    const r = makeResource({ sourceId: 's', url: 'https://b.com/a', source: 'manual' });
    expect(r.title).toBe('b.com');
  });

  it('备注会被 trim + 截断', () => {
    const r = makeResource({
      sourceId: 's',
      url: 'https://a.com',
      source: 'manual',
      note: '  第 3 节看这个  ',
    });
    expect(r.note).toBe('第 3 节看这个');
  });

  it('空备注不写入字段', () => {
    const r = makeResource({ sourceId: 's', url: 'https://a.com', source: 'manual', note: '  ' });
    expect(r.note).toBeUndefined();
  });
});

describe('normalizeResources：坏数据不能崩', () => {
  it('非对象输入 → 空表', () => {
    expect(normalizeResources(null)).toEqual({});
    expect(normalizeResources(undefined)).toEqual({});
    expect(normalizeResources([])).toEqual({});
    expect(normalizeResources('x')).toEqual({});
  });

  it('逐条校验，坏条目丢掉（不留点不开的资源）', () => {
    const out = normalizeResources({
      'src-1': [
        { url: 'https://good.com/a', title: '好的', source: 'manual' },
        { url: 'javascript:alert(1)' },
        { url: '' },
        { title: '没有 url' },
        null,
        'string',
      ],
    });
    expect(out['src-1']).toHaveLength(1);
    expect(out['src-1']![0]!.url).toBe('https://good.com/a');
  });

  it('某个 sourceId 全坏 → 该键不出现（不留空数组）', () => {
    const out = normalizeResources({ 'src-1': [{ url: 'bad' }] });
    expect(out['src-1']).toBeUndefined();
  });

  it('缺 title → 用域名补上', () => {
    const out = normalizeResources({ s: [{ url: 'https://a.com/x' }] });
    expect(out['s']![0]!.title).toBe('a.com');
  });

  it('缺 id → 生成一个', () => {
    const out = normalizeResources({ s: [{ url: 'https://a.com' }] });
    expect(out['s']![0]!.id.startsWith('res_')).toBe(true);
  });

  it('source 只认 search，其余归 manual', () => {
    const out = normalizeResources({
      s: [
        { url: 'https://a.com/1', source: 'search' },
        { url: 'https://a.com/2', source: 'weird' },
        { url: 'https://a.com/3' },
      ],
    });
    expect(out['s']!.map((r) => r.source)).toEqual(['search', 'manual', 'manual']);
  });

  it('⚠️ 旧数据没有 sectionId → 归一成 null（资料级），不丢', () => {
    const out = normalizeResources({ s: [{ url: 'https://a.com' }] });
    expect(out['s']![0]!.sectionId).toBeNull();
  });
});

describe('relativeTime：列表里的时间标注', () => {
  const now = new Date('2026-11-22T12:00:00.000Z');

  it('刚加的', () => {
    expect(relativeTime('2026-11-22T11:59:50.000Z', now)).toBe('刚加的');
  });

  it('N 分钟前', () => {
    expect(relativeTime('2026-11-22T11:30:00.000Z', now)).toBe('30 分钟前');
  });

  it('N 小时前', () => {
    expect(relativeTime('2026-11-22T08:00:00.000Z', now)).toBe('4 小时前');
  });

  it('N 天前', () => {
    expect(relativeTime('2026-11-19T12:00:00.000Z', now)).toBe('3 天前');
  });

  it('超过 30 天给日期（比「127 天前」好读）', () => {
    expect(relativeTime('2026-06-01T12:00:00.000Z', now)).toMatch(/^2026-06-0[12]$/);
  });

  it('⚠️ 未来时间（时钟不同步）显示「刚加的」，不显示负数', () => {
    expect(relativeTime('2026-11-23T12:00:00.000Z', now)).toBe('刚加的');
  });

  it('空/坏输入 → 空串（不显示乱码）', () => {
    expect(relativeTime('', now)).toBe('');
    expect(relativeTime('not a date', now)).toBe('');
  });
});

describe('hostOf', () => {
  it('取域名并去 www.', () => {
    expect(hostOf('https://www.bilibili.com/video/x')).toBe('bilibili.com');
  });

  it('坏 URL → 空串', () => {
    expect(hostOf('nope')).toBe('');
  });
});