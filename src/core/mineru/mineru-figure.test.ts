import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

/**
 * 取图模块（electron/mineru-figure.cjs）的纯逻辑测试。
 *
 * ## 为什么测 electron 下的文件
 *
 * 这个文件虽然住在 electron/，但里面大部分是**纯函数**（解析 endpoint、
 * 解析 token、从响应里取 asset）。取图错了最难查 —— 图不显示时，
 * 你分不清是「locator 格式坏」「服务没起」「token 不对」还是「路径读不到」。
 * 所以把可单测的部分全拆出来，喂真实响应样本。
 *
 * 用 createRequire 加载 .cjs：vitest 的 include 只收 src/**，
 * 而 electron/ 是 CommonJS（主进程用 require）。这样两边都不用改约定。
 */

const require_ = createRequire(import.meta.url);
const fig = require_('../../../electron/mineru-figure.cjs') as {
  parseEndpoint: (x: unknown) => string | null;
  parseAuthToken: (y: unknown) => string | null;
  pickImageFromResponse: (x: unknown) => {
    path: string;
    mimeType: string;
    width: number;
    height: number;
    sizeBytes: number;
  } | null;
  extOfMime: (m: string) => string;
  candidateHomes: (exe: string | null, env: Record<string, string>, home: string | null) => string[];
  toDataUri: (d: Buffer, m: string) => string;
};

describe('parseEndpoint', () => {
  it('解析真实的 doclib.endpoint.json', () => {
    // 实测样本（2026-11-08 本机）
    const json = JSON.stringify({
      pid: 7648,
      server_id: '9f6f2f07-6dc5-42b1-8068-2f5dda410573',
      transports: [{ base_url: 'http://127.0.0.1:15980', type: 'tcp' }],
      version: 3,
    });
    expect(fig.parseEndpoint(json)).toBe('http://127.0.0.1:15980');
  });

  it('去掉末尾斜杠（拼 URL 时不会出现双斜杠）', () => {
    const json = JSON.stringify({ transports: [{ base_url: 'http://127.0.0.1:15980/' }] });
    expect(fig.parseEndpoint(json)).toBe('http://127.0.0.1:15980');
  });

  it('多个 transport 时取第一个 http 的', () => {
    const json = JSON.stringify({
      transports: [{ type: 'uds' }, { base_url: 'http://127.0.0.1:1' }],
    });
    expect(fig.parseEndpoint(json)).toBe('http://127.0.0.1:1');
  });

  it('坏输入返回 null 而不是抛（调用方据此回落 CLI）', () => {
    expect(fig.parseEndpoint('')).toBeNull();
    expect(fig.parseEndpoint('{坏 json')).toBeNull();
    expect(fig.parseEndpoint({})).toBeNull();
    expect(fig.parseEndpoint({ transports: [] })).toBeNull();
    expect(fig.parseEndpoint(null)).toBeNull();
  });
});

describe('parseAuthToken', () => {
  it('从真实 config.yaml 形状里取 token', () => {
    // 实测样本形状（doclib.auth.token）
    const yaml = ['model:', '  source: modelscope', 'doclib:', '  auth:', '    token: abc123XYZ_-'].join('\n');
    expect(fig.parseAuthToken(yaml)).toBe('abc123XYZ_-');
  });

  it('取不到返回 null（宁可回落 CLI，也不猜 token 去撞 401）', () => {
    expect(fig.parseAuthToken('model:\n  source: modelscope')).toBeNull();
    expect(fig.parseAuthToken('token:')).toBeNull();
    expect(fig.parseAuthToken('')).toBeNull();
    expect(fig.parseAuthToken(null)).toBeNull();
  });

  it('token 里的 - 和 _ 要原样保留（base64url 常见）', () => {
    expect(fig.parseAuthToken('    token: a-b_c-d')).toBe('a-b_c-d');
  });
});

describe('pickImageFromResponse', () => {
  it('从真实 HTTP 响应里取出 asset 信息', () => {
    /*
     * 实测响应（2026-11-08，GET /api/v1/content?format=image）。
     * 注意 asset.path 指向 MinerU 自己的临时目录，
     * 我们必须在它被清理前把字节读走。
     */
    const json = JSON.stringify({
      sha256: '87731dfd78829f56afa2f4cdccfe6efe360855525f74c31da7dcdf017694ac3a',
      short_id: '87731df',
      tier: 'standard',
      format: 'image',
      content: '',
      asset: {
        path: 'C:\\Users\\ASUS\\.mineru\\doclib\\temp\\read-assets\\87731df-1794136743084.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 7686,
        width: 416,
        height: 216,
      },
    });
    const p = fig.pickImageFromResponse(json);
    expect(p?.mimeType).toBe('image/jpeg');
    expect(p?.width).toBe(416);
    expect(p?.height).toBe(216);
    expect(p?.path).toContain('read-assets');
  });

  it('缺 path 返回 null', () => {
    expect(fig.pickImageFromResponse(JSON.stringify({ format: 'image' }))).toBeNull();
    expect(fig.pickImageFromResponse(JSON.stringify({ asset: {} }))).toBeNull();
    expect(fig.pickImageFromResponse('')).toBeNull();
    expect(fig.pickImageFromResponse('{坏')).toBeNull();
  });

  it('宽高缺失时给 0，不是 NaN（后续要按比例占位）', () => {
    const p = fig.pickImageFromResponse(JSON.stringify({ asset: { path: 'a.jpg' } }));
    expect(p?.width).toBe(0);
    expect(p?.height).toBe(0);
  });
});

describe('extOfMime', () => {
  it('按 MIME 给扩展名', () => {
    expect(fig.extOfMime('image/jpeg')).toBe('.jpg');
    expect(fig.extOfMime('image/png')).toBe('.png');
    expect(fig.extOfMime('image/webp')).toBe('.webp');
  });

  it('认不出给 .jpg（MinerU 默认出 jpeg）', () => {
    expect(fig.extOfMime('application/octet-stream')).toBe('.jpg');
    expect(fig.extOfMime('')).toBe('.jpg');
  });
});

describe('candidateHomes', () => {
  it('优先 MINERU_HOME 环境变量', () => {
    const homes = fig.candidateHomes(null, { MINERU_HOME: 'D:\\custom' }, 'C:\\Users\\x');
    expect(homes[0]).toBe('D:\\custom');
  });

  it('从 mineru.exe 路径推出 StudyHub 布局的 home', () => {
    const homes = fig.candidateHomes('E:\\StudyHub\\MinerU\\venv\\Scripts\\mineru.exe', {}, null);
    expect(homes).toContain('E:\\StudyHub\\MinerU\\home');
  });

  it('也包含 ~/.mineru —— 实测服务实际用的是这个，不是 StudyHub 的 home', () => {
    /*
     * 2026-11-08 实测：`mineru server status` 显示
     * Home = C:\Users\ASUS\.mineru，而 StudyHub 布局下还有
     * E:\StudyHub\MinerU\home。两个位置都可能存在，
     * 必须按「哪个有 endpoint.json」判断当前服务在哪个 home 跑 ——
     * 读错 home 会拿到过期端口，表现是取图全部 401/连不上。
     */
    const homes = fig.candidateHomes(null, {}, 'C:\\Users\\x');
    expect(homes).toContain('C:\\Users\\x\\.mineru');
  });

  it('什么都不给时返回空数组，不崩', () => {
    expect(fig.candidateHomes(null, {}, null)).toEqual([]);
  });
});

describe('toDataUri', () => {
  it('转成 data URI（渲染进程不能直接拿 Buffer 当 img src）', () => {
    const uri = fig.toDataUri(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    expect(uri).toBe('data:image/jpeg;base64,/9j/');
  });

  it('缺 MIME 时按 jpeg', () => {
    expect(fig.toDataUri(Buffer.from([1, 2]), '').startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});
