/**
 * 只读统计某个 userData 目录里 IndexedDB 的**现存**记录数。
 *
 * 为什么不用 strings：
 *   leveldb 的 .log 是**追加写**的，删掉的记录和覆盖前的旧值都还在文件里。
 *   直接数 "deck_xxx" 这类字符串会把已经删掉的也算上，结论正好相反。
 *
 * 做法：
 *   按 leveldb 的 write-ahead log 格式逐条重放 —— 每条记录带 7 字节序列号
 *   和 1 字节类型（1=put / 0=delete），按序列号顺序应用，删除才是删除。
 *   目录里只有 .log（没有 .sst/.ldb），所以重放就是全量。
 *
 * 用法：node scripts/idb-live-count.cjs --data <openleaner-data 目录>
 */

const fs = require('node:fs');
const path = require('node:path');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DATA_DIR = arg('data', '');
if (!DATA_DIR) {
  console.error('用法: node scripts/idb-live-count.cjs --data <openleaner-data 目录>');
  process.exit(2);
}

/** 解析一个 leveldb log 文件，返回 [{seq, type, key, value}]（按文件中出现顺序） */
function readLog(file) {
  const buf = fs.readFileSync(file);
  const out = [];
  let pos = 0;
  while (pos + 7 <= buf.length) {
    const blockLeft = 32768 - (pos % 32768);
    // 块尾不足 7 字节的部分是 padding
    if (blockLeft < 7) {
      pos += blockLeft;
      continue;
    }
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    if (len === 0 && type === 0) {
      // 预分配的零区（文件尾常见），跳过整块
      pos += blockLeft;
      continue;
    }
    if (type < 1 || type > 4) {
      pos += blockLeft;
      continue;
    }
    const start = pos + 7;
    const end = start + len;
    if (end > buf.length || start + len > pos + blockLeft) {
      pos += blockLeft;
      continue;
    }
    out.push({ data: buf.subarray(start, end) });
    pos = end;
  }
  return out;
}

/** 把分片记录（FIRST/MIDDLE/LAST）拼回完整逻辑记录 */
function assembleFragments(frags) {
  const logical = [];
  let acc = null;
  for (const f of frags) {
    // 分片类型在 payload 末尾单独解析；这里重新按块读，简化：整块当成完整记录
    logical.push(f.data);
  }
  return logical;
}

/**
 * 逐条解析「完整记录」：seq(7) + count(2) + 若干 {tag(1), key, value}
 *
 * 这里重新读一遍文件，这次同时处理分片（多数记录小于块，够用；
 * 遇到分片则跳过并计数，报告里说明）。
 */
function readRecords(file) {
  const buf = fs.readFileSync(file);
  const records = [];
  let skippedFragments = 0;
  let pos = 0;
  let pending = null;
  while (pos + 7 <= buf.length) {
    const blockLeft = 32768 - (pos % 32768);
    if (blockLeft < 7) {
      pos += blockLeft;
      continue;
    }
    const len = buf.readUInt16LE(pos + 4);
    const ftype = buf[pos + 6];
    if (len === 0 && ftype === 0) {
      pos += blockLeft;
      continue;
    }
    if (ftype < 1 || ftype > 4) {
      pos += blockLeft;
      continue;
    }
    const start = pos + 7;
    const end = Math.min(start + len, buf.length);
    const chunk = buf.subarray(start, end);
    pos = end;

    if (ftype === 1) {
      records.push(chunk);
    } else if (ftype === 2) {
      pending = [chunk];
    } else if (ftype === 3) {
      if (pending) pending.push(chunk);
    } else if (ftype === 4) {
      if (pending) {
        pending.push(chunk);
        records.push(Buffer.concat(pending));
        pending = null;
      }
    } else {
      skippedFragments++;
    }
  }
  return { records, skippedFragments };
}

/** 解析一条 write batch，返回 [{seq, tag, key, value}] */
function parseBatch(rec) {
  if (rec.length < 12) return [];
  // SequenceNumber: 8 字节定长；Count: 4 字节定长
  const seq = Number(rec.readBigUInt64LE(0) & 0xffffffffffn);
  const count = rec.readUInt32LE(8);
  const items = [];
  let p = 12;

  /** varint32（LevelDB 的 VarLengthString 长度是 varint，不是定长！） */
  function varint() {
    let result = 0;
    let shift = 0;
    while (p < rec.length) {
      const b = rec[p++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 35) return result;
    }
    return result;
  }

  for (let i = 0; i < count && p < rec.length; i++) {
    const tag = rec[p++];
    const klen = varint();
    const key = rec.subarray(p, p + klen);
    p += klen;
    let value = null;
    if (tag === 1) {
      const vlen = varint();
      value = rec.subarray(p, p + vlen);
      p += vlen;
    }
    items.push({ seq, tag, key, value });
  }
  return items;
}

const dbDir = path.join(DATA_DIR, 'IndexedDB');
if (!fs.existsSync(dbDir)) {
  console.error(`没有 IndexedDB 目录：${dbDir}`);
  process.exit(2);
}

console.log(`\n=== ${DATA_DIR} ===`);
for (const sub of fs.readdirSync(dbDir)) {
  const dir = path.join(dbDir, sub);
  if (!fs.statSync(dir).isDirectory()) continue;
  const logs = fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.log$/.test(f))
    .sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]));
  const ssts = fs.readdirSync(dir).filter((f) => /\.(sst|ldb)$/.test(f));
  if (logs.length === 0) continue;

  const live = new Map(); // key(hex) -> {tag, value}
  let skips = 0;
  for (const f of logs) {
    const { records, skippedFragments } = readRecords(path.join(dir, f));
    skips += skippedFragments;
    const items = [];
    for (const r of records) items.push(...parseBatch(r));
    items.sort((a, b) => a.seq - b.seq);
    for (const it of items) {
      const hex = it.key.toString('hex');
      if (it.tag === 0) live.delete(hex);
      else live.set(hex, it);
    }
  }

  console.log(`\n--- ${sub}（log ${logs.length} 个，sst ${ssts.length} 个）---`);
  if (ssts.length > 0) console.log('  ⚠ 存在压缩后的 sst，本统计只含 log 部分');

  /*
   * IndexedDB 的 key 结构（Chromium）：
   *   <dbId:8><objectStoreId:8? fragmented><indexId:8><key...>
   * 用「对象存档 id → 名字」的元数据记录来翻译；拿不到就按前 16 字节分组。
   */
  const groups = new Map();
  for (const [hex, it] of live) {
    const raw = it.key;
    const prefix = raw.subarray(0, Math.min(raw.length, 16)).toString('hex');
    groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
  }

  // 尝试从元数据里翻出 store 名字
  const names = new Set();
  for (const [hex, it] of live) {
    const t = it.value ? it.value.toString('latin1') : '';
    for (const m of t.matchAll(
      /(sourceSegments|knowledgePoints|decks|cards|sources|reviewLogs|backends|secrets|appSettings|settings|courses|libraries|generationRuns|answerRecords|todoItems|notes|slides|slideImages|usageLogs|comments)/g,
    )) {
      names.add(m[1]);
    }
  }
  console.log(`  现存记录总数: ${live.size}`);
  if (skips) console.log(`  跳过的分片: ${skips}`);
  console.log(`  出现的分区名: ${[...names].sort().join(', ') || '(未识别)'}`);
}
