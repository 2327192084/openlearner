/**
 * id 生成。
 *
 * 用 crypto.randomUUID 而不是自增数字：学习库要能导出、在另一台机器导入，
 * 自增 id 在合并/导入时必然撞车。
 */
export function newId(prefix: string): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : fallbackUuid();
  return `${prefix}_${uuid}`;
}

/** 极老运行环境的兜底（Electron/现代浏览器都用不到，仅防 run 崩） */
function fallbackUuid(): string {
  const rnd = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${rnd()}${rnd()}-${rnd()}-${rnd()}-${rnd()}-${rnd()}${rnd()}${rnd()}`;
}

/** 统一的 ISO 时间戳，便于备份文件按时间排序与人工阅读 */
export function nowIso(): string {
  return new Date().toISOString();
}
