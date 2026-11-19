// Deck injector: mounts a minimal context usage pill into the Antigravity
// composer footer (next to the model selector) via the local DevTools (CDP) endpoint.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const INTERVAL_MS = 1000;
const INSTANCE_TS = Date.now();

function resolvePortFile() {
  // AGY_BROWSER_ACTIVE_PORT_FILE is exported by Antigravity only when it was
  // started with --remote-debugging-port; follow it if present.
  const fromEnv = process.env.AGY_USAGE_CDP_PORT_FILE || process.env.AGY_BROWSER_ACTIVE_PORT_FILE;
  if (fromEnv) return fromEnv;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity', 'DevToolsActivePort');
}

const PORT_FILE = resolvePortFile();

const sockets = new Map(); // targetId -> { ws, pending: Map, nextId }
let lastErr = '';

function logOnce(msg) {
  if (msg !== lastErr) {
    lastErr = msg;
    console.error('[agy-usage]', msg);
  }
}

function readCdpPort() {
  try {
    return readFileSync(PORT_FILE, 'utf-8').split('\n')[0].trim();
  } catch {
    return '';
  }
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const entry = { ws, pending: new Map(), nextId: 1 };
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws timeout')), 3000);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error('ws error'));
    };
  });
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      const cb = entry.pending.get(msg.id);
      if (cb) {
        entry.pending.delete(msg.id);
        cb(msg);
      }
    } catch {}
  };
  ws.onclose = () => sockets.delete(target.id);
  sockets.set(target.id, entry);
  return entry;
}

function evaluate(entry, expression) {
  return new Promise((resolve) => {
    const id = entry.nextId++;
    const t = setTimeout(() => {
      entry.pending.delete(id);
      resolve(undefined);
    }, 3000);
    entry.pending.set(id, (msg) => {
      clearTimeout(t);
      resolve(msg?.result?.result?.value);
    });
    entry.ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      })
    );
  });
}

// Self-contained function executed inside the Antigravity renderer page.
function pageMount(d) {
  if (window.__agyUsageOwnerTs && d.instanceTs && d.instanceTs < window.__agyUsageOwnerTs) {
    return 'superseded';
  }
  if (d.instanceTs) {
    window.__agyUsageOwnerTs = d.instanceTs;
  }
  const footerLeft = document.querySelector('.agy-composer-footer > div:first-child');
  if (!footerLeft) return 'no-footer';

  let root = document.getElementById('agy-usage-strip');
  if (!root) {
    root = document.createElement('div');
    root.id = 'agy-usage-strip';
  }

  if (root.getAttribute('data-ver') !== '1') {
    root.setAttribute('data-ver', '1');
    root.style.cssText = [
      'display: inline-flex',
      'align-items: center',
      'flex-shrink: 0',
      'margin-left: 6px',
      'margin-right: 6px',
      'font-size: 12.5px',
      'font-family: "Source Han Sans CN", "思源黑体 CN", "Source Han Sans SC", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif',
      'font-weight: 400',
      'font-variation-settings: normal',
      'font-variant-ligatures: normal',
      'line-height: normal',
      'color: var(--secondary-foreground, var(--foreground, #3f3f46))',
      'user-select: none',
      'position: relative',
      '-webkit-font-smoothing: antialiased',
    ].join(';');

    root.innerHTML = `
      <style>
        #agy-usage-strip .au-pill {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 3px 5px;
          border-radius: 6px;
          cursor: default;
          background: transparent;
          border: none;
          white-space: nowrap;
          transition: background 0.12s ease, color 0.12s ease;
        }
        #agy-usage-strip:hover .au-pill {
          background: var(--secondary, rgba(128, 128, 128, 0.12));
          color: var(--foreground, #0a0a0c);
        }
        #agy-usage-strip:hover .au-val,
        #agy-usage-strip:hover .au-svg {
          color: var(--foreground, #0a0a0c);
        }
        #agy-usage-strip .au-svg {
          width: 13px;
          height: 13px;
          color: var(--muted-foreground, rgba(142, 142, 147, 0.85));
          flex-shrink: 0;
          transition: color 0.12s ease;
        }
        #agy-usage-strip .au-val {
          font-weight: 500;
          color: var(--muted-foreground, #71717a);
          font-variant-numeric: tabular-nums;
          transition: color 0.12s ease;
        }
        #agy-usage-strip.au-hide-val .au-val {
          display: none;
        }
        #agy-usage-strip.au-hide-val .au-pill {
          gap: 0;
        }
        #agy-usage-strip.au-hide-all {
          display: none !important;
        }
      </style>
      <div class="au-pill" data-el="pill">
        <svg class="au-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>
        <span class="au-val" data-k="label">0 ( 0% )</span>
      </div>
    `;
  }

  const justMounted = !footerLeft.contains(root);
  if (justMounted) {
    footerLeft.appendChild(root);
  }

  const labelEl = root.querySelector('[data-k="label"]');
  const labelChanged = !!(labelEl && labelEl.textContent !== d.label);
  if (labelChanged) {
    labelEl.textContent = d.label;
  }
  const pillEl = root.querySelector('[data-el="pill"]');
  if (pillEl && pillEl.title !== d.tooltip) {
    pillEl.title = d.tooltip;
  }

  const adjustLayout = () => {
    const footer = footerLeft.parentElement;
    const nativeChildren = Array.from(footerLeft.children).filter((c) => c !== root);
    const modes = [[], ['au-hide-val'], ['au-hide-all']];

    for (const clsList of modes) {
      root.classList.toggle('au-hide-val', clsList.includes('au-hide-val'));
      root.classList.toggle('au-hide-all', clsList.includes('au-hide-all'));
      if (clsList.includes('au-hide-all')) break;

      const rootRect = root.getBoundingClientRect();
      if (rootRect.width <= 0) continue;

      const rightControls = footer
        ? Array.from(footer.children).filter((el) => el !== footerLeft && el.getBoundingClientRect().width > 0)
        : [];
      const rightMinLeft =
        rightControls.length > 0
          ? Math.min(...rightControls.map((el) => el.getBoundingClientRect().left))
          : Infinity;
      const footerCs = footer ? getComputedStyle(footer) : null;
      const footerRightEdge = footer
        ? footer.getBoundingClientRect().right - (parseFloat(footerCs.paddingRight) || 0)
        : Infinity;
      const flCs = getComputedStyle(footerLeft);
      const flClipRight = flCs.overflowX !== 'visible' ? footerLeft.getBoundingClientRect().right + 1 : Infinity;

      let nativeMaxRight = -Infinity;
      for (const c of nativeChildren) {
        const r = c.getBoundingClientRect();
        if (r.right > nativeMaxRight) nativeMaxRight = r.right;
      }

      const fitsRight =
        rootRect.right <= rightMinLeft - 4 &&
        rootRect.right <= footerRightEdge + 1 &&
        rootRect.right <= flClipRight;
      const fitsLeft = nativeMaxRight === -Infinity || rootRect.left >= nativeMaxRight + 3;
      if (fitsRight && fitsLeft) break;
    }
  };
  root._adjustLayout = adjustLayout;

  if (root._observedFooterLeft !== footerLeft) {
    if (root._resizeObserver) root._resizeObserver.disconnect();
    root._observedFooterLeft = footerLeft;
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (root._adjustLayout) root._adjustLayout();
      });
      if (footerLeft.parentElement) ro.observe(footerLeft.parentElement);
      ro.observe(footerLeft);
      root._resizeObserver = ro;
    }
  }

  if (justMounted || labelChanged) {
    adjustLayout();
  }
  return 'ok';
}

function fmtK(n) {
  const num = Number(n || 0);
  if (num < 1000) return String(num);
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
}

function toView(d) {
  const ctx = d.contextTokens || 0;
  const maxCtx = d.maxContextTokens || 0;
  const hasMax = maxCtx > 0;
  const pct = hasMax ? Math.round((ctx / maxCtx) * 100) + '%' : ctx === 0 ? '0%' : '--%';
  const label = `${fmtK(ctx)} ( ${pct} )`;
  const tooltip = `${ctx.toLocaleString()} / ${hasMax ? maxCtx.toLocaleString() : '--'} tokens`;

  return {
    label,
    tooltip,
    instanceTs: INSTANCE_TS,
  };
}

async function tick(inspect, state) {
  const port = readCdpPort();
  if (!port) return state.set('missing');
  let targets;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    targets = await res.json();
  } catch (e) {
    return state.set('unreachable', 'CDP list failed: ' + e.message);
  }
  state.set('ok');
  const pages = targets.filter(
    (t) => t.type === 'page' && /^https?:\/\/127\.0\.0\.1(:\d+)?\//.test(t.url || '') && t.webSocketDebuggerUrl
  );
  for (const t of pages) {
    try {
      const entry = sockets.get(t.id) || (await connect(t));
      const path = (await evaluate(entry, 'location.pathname')) || '';
      const m = path.match(/\/c\/([0-9a-f-]{36})/);
      const data = inspect(m ? m[1] : '', true);
      const res = await evaluate(entry, `(${pageMount.toString()})(${JSON.stringify(toView(data))})`);
      if (res === 'superseded') {
        process.exit(0);
      }
      if (res === 'ok') lastErr = '';
    } catch (e) {
      sockets.delete(t.id);
      logOnce('page ' + t.id + ': ' + e.message);
    }
  }
}

export { pageMount, toView };

export function startDeckInjector(inspect, options = {}) {
  let busy = false;
  let stopped = false;
  // 'unknown' | 'ok' | 'missing' | 'unreachable' — the sidebar-less plugin uses
  // this to decide whether to offer debugging-port setup.
  let cdpState = 'unknown';

  const state = {
    set(next, detail = '') {
      const changed = next !== cdpState;
      cdpState = next;
      if (next === 'missing') logOnce('DevToolsActivePort not found (remote debugging is off)');
      else if (next === 'unreachable') logOnce(detail || 'CDP unreachable');
      else if (next === 'ok') lastErr = '';
      if (changed) {
        try {
          options.onState?.(next, detail);
        } catch (e) {
          console.error('[agy-usage] onState handler failed:', e?.message || e);
        }
      }
    },
  };

  const timer = setInterval(async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await tick(inspect, state);
    } catch (e) {
      state.set('unreachable', e?.message || String(e));
    } finally {
      busy = false;
    }
  }, INTERVAL_MS);

  console.log('[agy-usage] injector started, port file:', PORT_FILE);
  return {
    status: () => cdpState,
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const entry of sockets.values()) {
        try {
          entry.ws.close();
        } catch {}
      }
      sockets.clear();
    },
  };
}
