import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { startDeckInjector } from './deck_injector.mjs';

const CONV_DIR = join(homedir(), '.gemini', 'antigravity', 'conversations');
const convCache = new Map(); // convId -> { sig, result }

function getDbSignature(dbPath) {
  let sig = '';
  try {
    const s = statSync(dbPath);
    sig += `${s.mtimeMs}:${s.size}`;
  } catch {
    return '';
  }
  const walPath = `${dbPath}-wal`;
  if (existsSync(walPath)) {
    try {
      const ws = statSync(walPath);
      sig += `|${ws.mtimeMs}:${ws.size}`;
    } catch {}
  }
  return sig;
}

function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return [Number(val), i];
    }
    shift += 7n;
  }
  return [Number(val), i];
}

function parsePbMap(buf) {
  const fields = new Map();
  let i = 0;
  while (i < buf.length) {
    try {
      const [tag, nextI] = readVarint(buf, i);
      i = nextI;
      const fn = tag >>> 3;
      const wt = tag & 7;
      if (fn === 0) break;
      if (!fields.has(fn)) fields.set(fn, []);
      if (wt === 0) {
        const [val, nI] = readVarint(buf, i);
        i = nI;
        fields.get(fn).push(val);
      } else if (wt === 2) {
        const [len, nI] = readVarint(buf, i);
        i = nI;
        if (len < 0 || i + len > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + len));
        i += len;
      } else if (wt === 5) {
        fields.get(fn).push(buf.subarray(i, i + 4));
        i += 4;
      } else if (wt === 1) {
        fields.get(fn).push(buf.subarray(i, i + 8));
        i += 8;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return fields;
}

function parseGenRow(idx, data) {
  if (!data || !Buffer.isBuffer(data)) data = Buffer.from(data || []);
  const top = parsePbMap(data);
  if (!top.has(1)) return null;
  const m1 = parsePbMap(top.get(1)[0]);
  const usageBuf = m1.has(4) ? m1.get(4)[0] : Buffer.alloc(0);
  const usage = parsePbMap(usageBuf);

  const uncachedIn = usage.has(2) ? usage.get(2)[0] : 0;
  const cachedIn = usage.has(5) ? usage.get(5)[0] : 0;
  const contextTokens = uncachedIn + cachedIn;

  let maxContextTokens = 0;
  if (m1.has(9)) {
    const m9 = parsePbMap(m1.get(9)[0]);
    if (m9.has(10)) {
      const m10 = parsePbMap(m9.get(10)[0]);
      if (m10.has(4)) {
        maxContextTokens = m10.get(4)[0];
      }
    }
  }

  return {
    turn: idx,
    contextTokens,
    maxContextTokens,
  };
}

function resolveLatestConvId() {
  if (!existsSync(CONV_DIR)) return '';
  const files = readdirSync(CONV_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({
      id: basename(f, '.db'),
      mtimeMs: statSync(join(CONV_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.length > 0 ? files[0].id : '';
}

function inspectConversation(convId, exact = false) {
  let targetId = '';
  if (exact) {
    if (!convId || !existsSync(join(CONV_DIR, `${convId}.db`))) {
      return { contextTokens: 0, maxContextTokens: 0 };
    }
    targetId = convId;
  } else {
    targetId =
      convId && existsSync(join(CONV_DIR, `${convId}.db`))
        ? convId
        : resolveLatestConvId();
    if (!targetId) {
      return { contextTokens: 0, maxContextTokens: 0 };
    }
  }

  const dbPath = join(CONV_DIR, `${targetId}.db`);
  const sig = getDbSignature(dbPath);
  const cached = convCache.get(targetId);
  if (sig && cached && cached.sig === sig) {
    return cached.result;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let contextTokens = 0;
  let maxContextTokens = 0;
  try {
    const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx DESC').all();
    for (const row of rows) {
      const parsed = parseGenRow(row.idx, row.data);
      if (!parsed) continue;
      if (contextTokens === 0 && parsed.contextTokens > 0) {
        contextTokens = parsed.contextTokens;
      }
      if (maxContextTokens === 0 && parsed.maxContextTokens > 0) {
        maxContextTokens = parsed.maxContextTokens;
      }
      if (contextTokens > 0 && maxContextTokens > 0) break;
    }
  } finally {
    db.close();
  }

  const result = {
    contextTokens,
    maxContextTokens,
  };
  if (sig) {
    convCache.set(targetId, { sig, result });
  }
  return result;
}

export { inspectConversation };

if (process.env.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  startDeckInjector(inspectConversation);
}
