import { statSync } from 'node:fs';

function fileStamp(path) {
  try {
    const s = statSync(path, { bigint: true });
    return { size: s.size, key: `${s.ino}:${s.size}:${s.mtimeNs}` };
  } catch {
    return null;
  }
}

// Cache database-derived values only; settings, quotas and local clocks remain live.
export function createSqliteSnapshotCache(readSnapshot) {
  const entries = new Map();
  return {
    read(path, includeTurnMetrics = true) {
      const db = fileStamp(path);
      if (!db || db.size === 0n) {
        entries.delete(path);
        return null;
      }
      const key = db.key + '|' + (fileStamp(path + '-wal')?.key || 'no-wal');
      const cached = entries.get(path);
      const previous = cached?.includeTurnMetrics === includeTurnMetrics ? cached : null;
      if (previous?.key === key) return previous.value;
      try {
        const value = readSnapshot(path, includeTurnMetrics);
        // Stamp BEFORE reading: a concurrent write must be retried next poll,
        // not accidentally cached as already consumed.
        entries.delete(path);
        entries.set(path, { key, includeTurnMetrics, value });
        if (entries.size > 8) entries.delete(entries.keys().next().value);
        return value;
      } catch {
        // An unready/temporarily busy DB may reuse only its own last good value for the same mode.
        // Do not advance the stamp, so the next poll retries it.
        return previous?.value ?? null;
      }
    },
  };
}
