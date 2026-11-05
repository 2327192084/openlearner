/**
 * 向后兼容的转发层。
 *
 * 这个文件原本是「DeepSeek 专用客户端」。改成多服务商之后，
 * 通用实现搬到了 `chat-client.ts`，但仓库里还有几处从 `./deepseek-client.ts`
 * 导入的地方（两个后端实现、测试）。
 *
 * 与其一次性改掉所有 import（容易漏、diff 也难看），不如保留这个转发层：
 * 所有导出原样转出去，调用方一行都不用改。
 *
 * 新代码请直接 `import ... from './chat-client.ts'`。
 */

export {
  ApiError,
  API_HINTS,
  chatCompletion,
  hintFor,
  redactSecrets,
} from './chat-client.ts';

export type { ApiErrorCode, ChatOptions, ChatResult } from './chat-client.ts';
