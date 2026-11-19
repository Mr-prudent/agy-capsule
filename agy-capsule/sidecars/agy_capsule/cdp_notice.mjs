import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_STATE_PATH = join(homedir(), '.gemini', 'config', 'agy-capsule', 'cdp_state.json');

const SHORTCUT_SCAN_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$dirs = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
$pattern = '(^|\\s)--remote-debugging-port(=\\S*)?(?=\\s|$)'
$shell = New-Object -ComObject WScript.Shell
$total = 0; $missing = 0
foreach ($d in $dirs) {
  foreach ($f in Get-ChildItem -LiteralPath $d -Recurse -Filter *.lnk) {
    $l = $shell.CreateShortcut($f.FullName)
    if ($l.TargetPath -and (Split-Path -Leaf $l.TargetPath) -eq 'Antigravity.exe') {
      $total++
      if ([string]$l.Arguments -notmatch $pattern) { $missing++ }
    }
  }
}
if ($total -eq 0) { 'unknown' } elseif ($missing -gt 0) { 'missing' } else { 'ok' }
`;

const SHORTCUT_FIX_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$dirs = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
$pattern = '(^|\\s)--remote-debugging-port(=\\S*)?(?=\\s|$)'
$shell = New-Object -ComObject WScript.Shell
$total = 0; $updated = 0; $failed = 0; $stillMissing = 0
foreach ($d in $dirs) {
  foreach ($f in Get-ChildItem -LiteralPath $d -Recurse -Filter *.lnk) {
    $l = $shell.CreateShortcut($f.FullName)
    if ($l.TargetPath -and (Split-Path -Leaf $l.TargetPath) -eq 'Antigravity.exe') {
      $total++
      $args = [string]$l.Arguments
      if ($args -match $pattern) { continue }
      try {
        $l.Arguments = "$args --remote-debugging-port=0".Trim()
        $l.Save()
        $updated++
      } catch {
        $failed++
        $stillMissing++
      }
    }
  }
}
$state = if ($total -eq 0) { 'unknown' } elseif ($stillMissing -gt 0) { 'missing' } else { 'ok' }
Write-Output ("$state,$updated,$failed,$total")
`;

const WIN_NOTIFY_PS = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
$n.BalloonTipTitle = $env:AGY_NOTIFY_TITLE
$n.BalloonTipText = $env:AGY_NOTIFY_BODY
$n.Visible = $true
$n.ShowBalloonTip(8000)
Start-Sleep -Milliseconds 6000
$n.Dispose()
`;

function runExec(execFileImpl, file, args, options = {}) {
  return new Promise(resolve => {
    execFileImpl(file, args, { encoding: 'utf8', windowsHide: true, timeout: 12000, ...options }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout || '').trim() });
    });
  });
}

export function createCdpNoticeManager(options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const platform = options.platform || process.platform;
  const sessionId = options.sessionId || process.env.ANTIGRAVITY_LS_ADDRESS || String(process.pid);
  const failThreshold = options.failThreshold ?? 3;
  const getPrefs = options.getPrefs || (() => ({}));
  const getNotifyText = options.getNotifyText || (() => ({ title: '', body: '' }));
  const execFileImpl = options.execFileImpl || execFile;

  let persisted = loadState();
  let consecutiveFails = 0;
  let shortcutState = 'unknown'; // 'unknown' | 'ok' | 'missing'
  let shortcutChecked = false;
  let shortcutPromise = null;
  let notified = false;
  let lastStatus = 'unknown';

  function loadState() {
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8'));
      return {
        everOk: raw?.everOk === true,
        lastOkAt: Number(raw?.lastOkAt) || 0,
        lastNotifiedSession: String(raw?.lastNotifiedSession || ''),
        lastNotifiedAt: Number(raw?.lastNotifiedAt) || 0,
      };
    } catch {
      return { everOk: false, lastOkAt: 0, lastNotifiedSession: '', lastNotifiedAt: 0 };
    }
  }

  function saveState() {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(persisted, null, 2) + '\n', 'utf8');
      renameSync(tmp, statePath);
    } catch {}
  }

  async function checkShortcuts() {
    if (platform !== 'win32') return 'unknown';
    if (shortcutPromise) return shortcutPromise;
    shortcutPromise = (async () => {
      const res = await runExec(execFileImpl, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SHORTCUT_SCAN_PS]);
      const line = res.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).at(-1);
      if (line === 'ok' || line === 'missing' || line === 'unknown') shortcutState = line;
      shortcutChecked = true;
      return shortcutState;
    })().finally(() => { shortcutPromise = null; });
    return shortcutPromise;
  }

  async function sendOsNotification(title, body) {
    if (!title || !body) return false;
    if (platform === 'win32') {
      const res = await runExec(execFileImpl, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_NOTIFY_PS], {
        env: { ...process.env, AGY_NOTIFY_TITLE: title, AGY_NOTIFY_BODY: body },
        timeout: 15000,
      });
      return res.ok;
    }
    if (platform === 'darwin') {
      const script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';
      const res = await runExec(execFileImpl, 'osascript', ['-e', script, title, body]);
      return res.ok;
    }
    if (platform === 'linux') {
      const res = await runExec(execFileImpl, 'notify-send', [title, body]);
      return res.ok;
    }
    return false;
  }

  async function maybeNotify(cdpState) {
    if (notified) return false;
    const hadBefore = persisted.everOk || cdpState === 'unreachable';
    if (!hadBefore) return false;
    const prefs = getPrefs() || {};
    if (prefs.notifyCdpRestart === false) return false;
    if (persisted.lastNotifiedSession === sessionId) {
      notified = true;
      return false;
    }
    if (platform === 'win32' && !shortcutChecked) await checkShortcuts();
    if (lastStatus === 'ok') return false;
    notified = true;
    persisted.lastNotifiedSession = sessionId;
    persisted.lastNotifiedAt = Date.now();
    saveState();
    const { title, body } = getNotifyText(shortcutState, prefs);
    return await sendOsNotification(title, body);
  }

  function observe(cdpState) {
    lastStatus = cdpState;
    if (cdpState === 'ok') {
      consecutiveFails = 0;
      shortcutState = 'ok';
      if (!persisted.everOk) {
        persisted.everOk = true;
        persisted.lastOkAt = Date.now();
        saveState();
      }
      return;
    }
    if (cdpState !== 'missing' && cdpState !== 'unreachable') return;
    consecutiveFails++;
    if (platform === 'win32' && !shortcutChecked) {
      void checkShortcuts();
    }
    if (consecutiveFails >= failThreshold && !notified) {
      void maybeNotify(cdpState);
    }
  }

  async function fixShortcuts() {
    if (platform !== 'win32') return { ok: false, updated: 0, failed: 0, total: 0, shortcutState };
    const res = await runExec(execFileImpl, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SHORTCUT_FIX_PS]);
    const line = res.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).at(-1) || '';
    const [nextState, updatedStr, failedStr, totalStr] = line.split(',');
    const updated = Number(updatedStr) || 0;
    const failed = Number(failedStr) || 0;
    const total = Number(totalStr) || 0;
    if (nextState === 'ok' || nextState === 'missing' || nextState === 'unknown') {
      shortcutState = nextState;
      shortcutChecked = true;
    }
    return { ok: res.ok && shortcutState === 'ok', updated, failed, total, shortcutState };
  }

  function info(cdpState = lastStatus) {
    const hadBefore = Boolean(persisted.everOk || cdpState === 'unreachable');
    return {
      state: cdpState,
      hadBefore,
      shortcutState,
      canFixShortcut: platform === 'win32' && shortcutState === 'missing',
    };
  }

  return { observe, info, checkShortcuts, fixShortcuts, maybeNotify };
}
