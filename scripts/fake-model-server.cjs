/**
 * 本地假模型服务器：只用于验证「认知层级筛选真的作用到了发出去的请求上」。
 *
 * ## 为什么需要一个真服务器而不是注入 fetch
 *
 * 单测里 `fetchImpl` 是注入的，验的是 service 内部逻辑。
 * 但用户报的问题恰恰是「界面勾了没用」—— 那要验的是
 * **从界面点按钮 → service → 主进程代理 → 实际 HTTP 请求体** 整条链。
 * 只有真的收到请求，才能证明「提示词里那段素材确实只剩 apply 层的」。
 *
 * ## 它做什么
 *
 * - 记录收到的每个请求体（脚本据此断言素材范围）
 * - 回一份合法的出题 JSON（题目引用它收到的**第一个素材 id**，
 *   并带上每个选项的 why —— 顺带验①的链路）
 *
 * 不联网、不花钱。监听的端口由调用方指定。
 */
const http = require('node:http');

function createFakeModel(opts = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {}

      /* /models：设置页「拉取模型列表」偶尔会打，给一份合法清单 */
      if (req.url && req.url.split('?')[0].endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'fake-model', object: 'model', owned_by: 'local' }],
          }),
        );
        return;
      }

      requests.push({ url: req.url, body: parsed, raw: body });

      /*
       * 从用户提示词里把素材 id 抠出来。
       * 提示词格式是 `- id: <id>`（见 buildQuestionUserPrompt）。
       */
      const userPrompt =
        parsed && Array.isArray(parsed.messages)
          ? (parsed.messages.find((m) => m.role === 'user')?.content ?? '')
          : '';
      const ids = [...userPrompt.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]);

      /* 要出几道：从「出 N 道题」里读，读不到就 1 道 */
      const countMatch = /出\s*(\d+)\s*道题/.exec(userPrompt);
      const want = countMatch ? Math.min(Number(countMatch[1]), 6) : 1;

      const questions = [];
      for (let i = 0; i < want && ids.length > 0; i++) {
        const kpId = ids[i % ids.length];
        questions.push({
          knowledgePointId: kpId,
          kind: 'single',
          prompt: `假模型第 ${i + 1} 题（依据 ${kpId}）`,
          options: [
            { key: 'A', text: '正确项', why: '这个选项符合定义，因为……' },
            { key: 'B', text: '干扰项', why: '这个选项把「有限」记成了「无限」，是常见误解' },
            { key: 'C', text: '另一个干扰项', why: '混淆了两个相近概念' },
            { key: 'D', text: '第四个选项', why: '不满足题设条件' },
          ],
          answer: 'A',
          explanation: '整体解析。',
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model: 'fake-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify({ questions }) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
        }),
      );
    });
  });

  return {
    server,
    requests,
    /** 最后一条请求的用户提示词 */
    lastUserPrompt() {
      for (let i = requests.length - 1; i >= 0; i--) {
        const r = requests[i];
        const msgs = r.body && r.body.messages;
        if (Array.isArray(msgs)) {
          const u = msgs.find((m) => m.role === 'user');
          if (u) return u.content ?? '';
        }
      }
      return '';
    },
    /** 最后一次请求里出现的素材 id 列表 */
    lastMaterialIds() {
      const p = this.lastUserPrompt();
      return [...p.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]);
    },
    listen(port) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createFakeModel };