# agy-usage

Antigravity 输入框底栏的极简上下文用量与百分比监控插件，直接读取本地会话数据库并实时展示当前会话的 Token 占用情况。

<p align="center">
  <img src="../assets/agy-usage-light.png" width="100%" alt="agy-usage 输入框底栏效果：显示当前上下文 Token 用量与占比" />
</p>

## 功能

- **极简内联显示**：嵌入 Antigravity 输入框底栏（紧邻模型选择器），实时显示当前会话的上下文 Token 用量与占比，如 `54.3K ( 11% )`（新会话显示 `0 ( 0% )`）。
- **本地数据库直读**：以只读模式读取本地 `~/.gemini/antigravity/conversations/` 下的会话 SQLite 数据库，解析 `gen_metadata` 中的最新上下文 Token 数与模型上下文上限，并通过文件/WAL 签名缓存减少重复读取。
- **悬停精确数值**：鼠标悬停在用量胶囊上可查看完整的精确 Token 数与上下文上限（如 `54,321 / 500,000 tokens`）。
- **窄屏自适应折叠**：通过 `ResizeObserver` 监听底栏宽度，空间不足时自动退让——先隐藏数字仅保留图标，空间极窄时自动隐藏，避免与底栏其他控件重叠。
- **昼夜自适应 & 零侵入挂载**：复用宿主 CSS 变量自动适配浅色/深色主题；通过原生 Sidecar 与本地 CDP（`DevToolsActivePort`）注入页面，不修改客户端源码，支持 macOS、Windows 与 Linux。
- **调试端口自愈**：Antigravity 更新后若在未带调试参数的情况下重启，插件会自动带上 `--remote-debugging-port=0` 重新拉起客户端（macOS，10 分钟内最多一次），其它情况弹出提示引导开启。

## 安装

1. 将 [`agy-usage`](./) 文件夹复制到 Antigravity 插件目录：
   - **Windows**: `%USERPROFILE%\.gemini\config\plugins\agy-usage`
   - **macOS / Linux**: `~/.gemini/config/plugins/agy-usage`
2. 在 Antigravity 的 **Plugins** 面板启用 **agy-usage**。

> 原包含多模型配额与 Token 构成明细的版本保留在 [`agy-capsule`](../agy-capsule) 目录中。

## 调试端口（CDP）说明

agy-usage 通过 Antigravity 的本地调试端口（CDP）把胶囊注入到底栏。**Antigravity 2.3x 起，只有带 `--remote-debugging-port=0` 启动时才会开放该端口**，否则启动时会主动删除 `DevToolsActivePort`，胶囊自然无法显示。

插件的行为：

- 检测到端口缺失时，日志会记录 `DevToolsActivePort not found (remote debugging is off)`。
- 如果此前端口是正常的（通常是客户端更新后自动重启导致），插件会在启动约 8 秒后**自动退出并带调试参数重新打开 Antigravity**，最多 10 分钟一次，避免重启循环。
- 首次使用或自动重启被限制时，会弹窗询问「立即重启 / 创建启动图标 / 稍后」。
- 设置环境变量 `AGY_USAGE_CDP_AUTO_RELAUNCH=0` 可关闭自动重启。

### macOS：创建带参数的启动图标

自动重启后调试参数只对当前这次运行有效。想以后每次都带着参数启动，可以用插件自动创建的启动器，或手动运行：

```sh
./scripts/enable-cdp.sh            # 在 ~/Applications 生成 Antigravity-CDP.app
./scripts/enable-cdp.sh --relaunch # 立刻退出并用调试参数重新打开
```

以后从 `Antigravity-CDP` 启动即可（建议替换程序坞里的原图标）。不要直接修改 `Antigravity.app` 内部文件，会破坏签名。

### Windows：给快捷方式加上参数

```powershell
powershell -ExecutionPolicy Bypass -File scripts\enable-cdp.ps1
```

脚本会为桌面、开始菜单和任务栏中指向 `Antigravity.exe` 的快捷方式追加 `--remote-debugging-port=0`；加 `-Undo` 可撤销。

### 验证

```sh
# 第一行是端口号即说明端口已开启
cat ~/Library/Application\ Support/Antigravity/DevToolsActivePort
```

更多 macOS 说明见 [`docs/macos-cdp.md`](../docs/macos-cdp.md)。

## License

[MIT](../LICENSE)
