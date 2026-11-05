import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  findPreset,
  isPresetLabel,
  normalizeBaseUrl,
  presetDefaults,
  resolveCompat,
} from './presets.ts';

/**
 * 服务商预设测试。
 *
 * 这一层的价值全在「琐碎但一定会踩」的边界上：
 * 地址末尾多个斜杠、用户整段粘进 /chat/completions、
 * 某家不认 JSON 模式、预设里写错一个字符导致所有人都连不上。
 * 所以断言集中在这些点上，而不是「数组有 8 项」。
 */

describe('预设清单自身的一致性', () => {
  it('id 不重复（重复会让下拉框选中错的服务商）', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('除「自定义」外，每家都有能用的地址；模型要么有默认值，要么显式标了「必须手填」', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === CUSTOM_PROVIDER_ID) continue;
      expect(preset.baseUrl, `${preset.id} 缺 baseUrl`).toMatch(/^https:\/\//);

      if (preset.modelMustBeFilled) {
        // 火山方舟这类：模型名是「接入点 ID」，无法预设。
        // 允许为空，但必须显式标记 —— 否则界面会把空模型名当默认值发出去。
        expect(preset.defaultModel, `${preset.id} 标了必须手填却又有默认模型`).toBe('');
        continue;
      }

      expect(preset.defaultModel, `${preset.id} 缺默认模型`).not.toBe('');
      // 默认模型必须在自己声明的候选列表里，否则下拉建议与实际不符
      expect(preset.models, `${preset.id} 的默认模型不在候选里`).toContain(preset.defaultModel);
    }
  });

  it('预设地址本身不带 /chat/completions（带了会拼成双份）', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.baseUrl).not.toMatch(/\/chat\/completions$/i);
    }
  });

  it('自定义项刻意留空，逼用户填自己的', () => {
    const custom = findPreset(CUSTOM_PROVIDER_ID);
    expect(custom).not.toBeNull();
    expect(custom!.baseUrl).toBe('');
    expect(custom!.defaultModel).toBe('');
  });
});

describe('normalizeBaseUrl：吃掉用户常见的地址写法错误', () => {
  it('去掉末尾斜杠（一个或多个）', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com');
    expect(normalizeBaseUrl('https://api.deepseek.com///')).toBe('https://api.deepseek.com');
  });

  it('去掉用户误粘的完整端点（真实高频错误）', () => {
    // 文档给的是完整端点，用户整段粘进来；再加一次就 404
    expect(normalizeBaseUrl('https://api.deepseek.com/chat/completions')).toBe(
      'https://api.deepseek.com',
    );
    expect(normalizeBaseUrl('https://api.moonshot.cn/v1/chat/completions')).toBe(
      'https://api.moonshot.cn/v1',
    );
  });

  it('兼容只写 /completions 的形状', () => {
    expect(normalizeBaseUrl('https://example.com/v1/completions')).toBe('https://example.com/v1');
  });

  it('保留 /v1 这类必要前缀（不能为了去尾巴把它也去掉）', () => {
    expect(normalizeBaseUrl('https://api.moonshot.cn/v1')).toBe('https://api.moonshot.cn/v1');
    expect(normalizeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
  });

  it('空串与纯空白返回空串（由调用方决定用什么兜底）', () => {
    expect(normalizeBaseUrl('')).toBe('');
    expect(normalizeBaseUrl('   ')).toBe('');
  });

  it('末尾斜杠 + 完整端点同时出现时也能处理', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/chat/completions/')).toBe(
      'https://api.deepseek.com',
    );
  });
});

describe('resolveCompat：决定能不能发 response_format', () => {
  it('已知服务商按预设返回', () => {
    expect(resolveCompat('deepseek')).toEqual({ jsonMode: true, vision: false });
    expect(resolveCompat('zhipu')).toEqual({ jsonMode: true, vision: true });
  });

  it('认不出的 provider 按标准 OpenAI 兼容处理（最通用的假设）', () => {
    expect(resolveCompat('some-relay-i-found')).toEqual({ jsonMode: true, vision: false });
    expect(resolveCompat('')).toEqual({ jsonMode: true, vision: false });
  });

  it('标了 jsonModeUnsupported 的服务不发 response_format', () => {
    // 这条用构造的方式验：目前所有预设都支持，但机制必须在
    const fake = { ...PROVIDER_PRESETS[0], id: 'fake-no-json', jsonModeUnsupported: true };
    PROVIDER_PRESETS.push(fake);
    try {
      expect(resolveCompat('fake-no-json').jsonMode).toBe(false);
    } finally {
      PROVIDER_PRESETS.pop();
    }
  });
});

describe('findPreset', () => {
  it('找得到就返回对应项', () => {
    expect(findPreset('moonshot')?.label).toContain('Kimi');
  });

  it('找不到返回 null（旧数据里可能有已下线的 provider）', () => {
    expect(findPreset('已经不存在了')).toBeNull();
  });
});

describe('isPresetLabel：切换服务商时该不该改名字', () => {
  it('名字等于预设 label 时算自动填的（切走可以改）', () => {
    expect(isPresetLabel(findPreset('deepseek')!.label, 'deepseek')).toBe(true);
  });

  it('空名字算自动填的', () => {
    expect(isPresetLabel('', 'deepseek')).toBe(true);
    expect(isPresetLabel('   ', 'deepseek')).toBe(true);
  });

  it('认历史别名：老版本存的是「DeepSeek」，预设 label 后来改长了', () => {
    // 不认这个别名的话，老用户切到智谱后名字会停在 DeepSeek，
    // 而地址已经变成智谱 —— 卡片写着 DeepSeek、实际发去智谱
    expect(isPresetLabel('DeepSeek', 'deepseek')).toBe(true);
  });

  it('用户自己起的名字必须保住', () => {
    expect(isPresetLabel('我的便宜通道', 'deepseek')).toBe(false);
  });

  it('另一个服务商的名字不该被当成本家的自动名', () => {
    expect(isPresetLabel(findPreset('zhipu')!.label, 'deepseek')).toBe(false);
  });
});

describe('presetDefaults', () => {
  it('返回完整的开箱配置', () => {
    expect(presetDefaults('zhipu')).toEqual({
      label: '智谱 GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-flash',
    });
  });

  it('未知 provider 返回 null', () => {
    expect(presetDefaults('nope')).toBeNull();
  });
});
