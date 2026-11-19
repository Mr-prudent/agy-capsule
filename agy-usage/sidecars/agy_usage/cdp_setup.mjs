// Handles the "Antigravity was launched without --remote-debugging-port" case.
//
// Antigravity 2.3x deletes DevToolsActivePort unless the app is started with
// --remote-debugging-port, so the footer pill cannot be injected at all. This
// module notices that, records whether CDP ever worked, and either relaunches
// Antigravity with the switch (macOS, once per cooldown) or tells the user how
// to fix it on their own.
import { execFile, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_STATE_PATH = join(homedir(), '.gemini', 'config', 'agy-usage', 'cdp_state.json');
const LAUNCHER_DIR = join(homedir(), 'Applications', 'Antigravity-CDP.app');
const RELAUNCH_COOLDOWN_MS = 10 * 60 * 1000;
const FAIL_THRESHOLD = 8;

const MAC_PROMPT_SCRIPT = `
on run argv
  set msg to item 1 of argv
  set res to display dialog msg with title "agy-usage" buttons {"稍后", "创建启动图标", "立即重启"} default button "立即重启" with icon caution
  return button returned of res
end run
`.trim();

const MAC_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIdentifier</key><string>local.agy-usage.antigravity-cdp</string>
  <key>CFBundleName</key><string>Antigravity-CDP</string>
  <key>CFBundleDisplayName</key><string>Antigravity-CDP</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;

const RELAUNCH_SCRIPT = `#!/bin/sh
# Quit Antigravity if it is running, then start it again with the debugging port.
sleep 0.5
osascript -e 'tell application "Antigravity" to quit' >/dev/null 2>&1
i=0
while pgrep -x Antigravity >/dev/null 2>&1 && [ "$i" -lt 60 ]; do
  sleep 0.25
  i=$((i + 1))
done
if pgrep -x Antigravity >/dev/null 2>&1; then
  exit 0
fi
open -a "Antigravity" --args --remote-debugging-port=0
`;

function runExec(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: 30000, ...options }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout || '').trim(), error: err });
    });
  });
}

function notifyDarwin(title, body) {
  return runExec('osascript', ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run', title, body]);
}

function notifyWindows(title, body) {
  const ps = `
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
  return runExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, AGY_NOTIFY_TITLE: title, AGY_NOTIFY_BODY: body },
    timeout: 15000,
  });
}

// Creates ~/Applications/Antigravity-CDP.app, a tiny wrapper that launches
// Antigravity with the debugging switch. Editing Antigravity.app itself would
// break its signature, so a launcher is the only durable macOS option.
export function installDarwinLauncher() {
  try {
    const macosDir = join(LAUNCHER_DIR, 'Contents', 'MacOS');
    const resourcesDir = join(LAUNCHER_DIR, 'Contents', 'Resources');
    mkdirSync(macosDir, { recursive: true });
    mkdirSync(resourcesDir, { recursive: true });

    writeFileSync(join(LAUNCHER_DIR, 'Contents', 'Info.plist'), MAC_INFO_PLIST, 'utf8');
    const launcher = join(macosDir, 'launcher');
    writeFileSync(launcher, '#!/bin/sh\nexec open -a "Antigravity" --args --remote-debugging-port=0\n', 'utf8');
    chmodSync(launcher, 0o755);

    const icon = join(resourcesDir, 'AppIcon.icns');
    const iconCandidates = ['icon.icns', 'electron.icns', 'app.icns'].map((name) =>
      join('/Applications/Antigravity.app/Contents/Resources', name)
    );
    const sourceIcon = iconCandidates.find((path) => existsSync(path));
    if (!existsSync(icon) && sourceIcon) {
      try {
        copyFileSync(sourceIcon, icon);
      } catch {}
    }
    // Nudge Finder/LaunchServices so the new app shows up with its icon.
    try {
      const now = new Date();
      utimesSync(LAUNCHER_DIR, now, now);
    } catch {}
    // Ad-hoc signature keeps Gatekeeper quiet on recent macOS releases.
    void runExec('/usr/bin/codesign', ['--force', '--sign', '-', LAUNCHER_DIR]);
    return LAUNCHER_DIR;
  } catch (e) {
    console.error('[agy-usage] failed to create launcher:', e?.message || e);
    return '';
  }
}

// Quits Antigravity and starts it again with --remote-debugging-port=0 from a
// detached script, so the relaunch survives this sidecar being killed.
export function relaunchDarwinWithCdp() {
  try {
    installDarwinLauncher();
    const scriptPath = join(tmpdir(), `agy-usage-relaunch-${process.pid}.sh`);
    writeFileSync(scriptPath, RELAUNCH_SCRIPT, 'utf8');
    chmodSync(scriptPath, 0o755);
    const child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (e) {
    console.error('[agy-usage] failed to relaunch Antigravity:', e?.message || e);
    return false;
  }
}

export function createCdpSetupManager(options = {}) {
  const platform = options.platform || process.platform;
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const sessionId = options.sessionId || process.env.ANTIGRAVITY_LS_ADDRESS || String(process.pid);
  const autoRelaunch =
    options.autoRelaunch ?? (process.env.AGY_USAGE_CDP_AUTO_RELAUNCH !== '0');
  const log = options.log || ((msg) => console.error('[agy-usage]', msg));

  let state = loadState();
  let failures = 0;
  let handled = false;
  let pending = false;
  let sawOkInSession = false;
  const firstSetupRetryMs = 12 * 60 * 60 * 1000;

  function loadState() {
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8'));
      return {
        everOk: raw?.everOk === true,
        lastRelaunchAt: Number(raw?.lastRelaunchAt) || 0,
        lastPromptSession: String(raw?.lastPromptSession || ''),
        lastPromptAt: Number(raw?.lastPromptAt) || 0,
      };
    } catch {
      return { everOk: false, lastRelaunchAt: 0, lastPromptSession: '', lastPromptAt: 0 };
    }
  }

  function saveState() {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
      renameSync(tmp, statePath);
    } catch {}
  }

  function instructions() {
    return platform === 'win32'
      ? 'Antigravity 启动时没有开启调试端口，底栏胶囊无法注入。请在 Antigravity 快捷方式的“目标”末尾加上 --remote-debugging-port=0，彻底退出后重新打开。'
      : 'Antigravity 启动时没有开启调试端口，底栏胶囊无法注入。请用 Antigravity-CDP 启动器（或运行 open -a Antigravity --args --remote-debugging-port=0）重新打开。';
  }

  async function promptDarwin() {
    const message = state.everOk
      ? 'Antigravity 调试端口已关闭（通常是更新后自动重启导致的），底栏胶囊暂时无法显示。\n\n是否立即重启 Antigravity 恢复显示？工作已经在会话里保存，重启只是带上调试参数重新打开。'
      : 'agy-usage 需要在带调试端口的方式下启动 Antigravity 才能显示底栏胶囊。\n\n是否立即重启 Antigravity？如果只想以后自己启动，可以点“创建启动图标”。';
    const res = await runExec('osascript', ['-e', MAC_PROMPT_SCRIPT, message], { timeout: 120000 });
    if (!res.ok) {
      log(`CDP unavailable. ${instructions()}`);
      return;
    }
    if (res.stdout === '立即重启') {
      log('relaunching Antigravity with --remote-debugging-port=0');
      state.lastRelaunchAt = Date.now();
      saveState();
      relaunchDarwinWithCdp();
    } else if (res.stdout === '创建启动图标') {
      const path = installDarwinLauncher();
      if (path) {
        log(`launcher created at ${path}; quit Antigravity and open it from there`);
        await notifyDarwin('agy-usage: 启动图标已创建', `请 Cmd+Q 退出 Antigravity，然后用 ${path} 重新打开。`);
      }
    }
  }

  async function handleUnavailable(cdpState) {
    if (handled) return;
    handled = true;
    const now = Date.now();
    const canAuto =
      platform === 'darwin' &&
      autoRelaunch &&
      state.everOk &&
      !sawOkInSession &&
      now - state.lastRelaunchAt > RELAUNCH_COOLDOWN_MS;

    if (canAuto) {
      log(`CDP ${cdpState} after startup; relaunching Antigravity with --remote-debugging-port=0`);
      state.lastRelaunchAt = now;
      saveState();
      relaunchDarwinWithCdp();
      return;
    }

    if (state.lastPromptSession === sessionId) return;
    if (!state.everOk && now - state.lastPromptAt < firstSetupRetryMs) {
      log(instructions());
      return;
    }
    state.lastPromptSession = sessionId;
    state.lastPromptAt = now;
    saveState();

    if (platform === 'darwin') {
      await promptDarwin();
      return;
    }

    log(instructions());
    if (platform === 'win32') {
      await notifyWindows('agy-usage: 需要开启调试端口', instructions());
    } else {
      await runExec('notify-send', ['agy-usage: 需要开启调试端口', instructions()]);
    }
  }

  function observe(cdpState) {
    if (cdpState === 'ok') {
      failures = 0;
      handled = false;
      sawOkInSession = true;
      if (!state.everOk) {
        state.everOk = true;
        saveState();
      }
      return;
    }
    if (cdpState !== 'missing' && cdpState !== 'unreachable') return;
    failures++;
    if (failures < FAIL_THRESHOLD || pending) return;
    pending = true;
    handleUnavailable(cdpState)
      .catch((e) => log('CDP setup failed: ' + (e?.message || e)))
      .finally(() => {
        pending = false;
      });
  }

  function info() {
    return { everOk: state.everOk, lastRelaunchAt: state.lastRelaunchAt };
  }

  return { observe, info, installLauncher: installDarwinLauncher, relaunch: relaunchDarwinWithCdp };
}
