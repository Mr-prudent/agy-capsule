# macOS 启用底栏胶囊（调试端口） / Enabling the Footer Capsule on macOS

[中文](#中文) | [English](#english)

## 中文

macOS 的替身（快捷方式）不能像 Windows 那样直接附带启动参数，所以如果不想每次都从终端启动，可以自己做一个**带参数的启动图标**。设置一次即可，以后直接点它打开 Antigravity。

### 第 0 步：先彻底退出 Antigravity

按 `Cmd + Q` 退出 Antigravity。  
注意：点窗口左上角的红色关闭按钮只会关掉窗口，程序仍在后台运行；如果后台已有进程，再次启动时附带的参数不会生效。

### 方法一：用「自动操作」做启动图标（推荐，所有 macOS 版本可用）

1. 按 `Cmd + 空格`，搜索并打开 **自动操作**（Automator）。
2. 点击 **新建文稿**，类型选择 **应用程序**。
3. 在左侧搜索 **运行 Shell 脚本**，把它拖到右侧区域。
4. 清空文本框里原有的内容（默认通常是 `cat`），换成下面这一行：

   ```sh
   open -a "Antigravity" --args --remote-debugging-port=0
   ```

5. 按 `Cmd + S` 保存，名字随便起（例如 `Antigravity-CDP`），保存到 **应用程序** 文件夹。
6. 以后双击这个新图标启动 Antigravity 即可，也可以把它拖到程序坞（Dock）里方便点击。

> **可选：换成原版图标**  
> 在「应用程序」文件夹里选中原版 `Antigravity` 按 `Cmd + I`，点信息窗口左上角的小图标后按 `Cmd + C`；再选中新建的 `Antigravity-CDP` 按 `Cmd + I`，点左上角小图标后按 `Cmd + V`。

### 方法二：用「快捷指令」（需要 macOS 14 Sonoma 或更新版本）

1. 打开 **快捷指令** App，先到 **设置 → 高级** 中勾选 **允许运行脚本**（不勾选会运行失败）。
2. 新建一个快捷指令，添加 **运行 Shell 脚本** 操作，填入同一行命令：

   ```sh
   open -a "Antigravity" --args --remote-debugging-port=0
   ```

3. 点菜单栏 **文件 → 添加到程序坞**。

### 怎么确认设置成功

用新图标启动 Antigravity 后：

- 输入框下方的底栏胶囊正常显示，且侧栏顶部的「底栏胶囊未启用」提示消失，即说明成功。
- 如需进一步排查，可在终端运行以下命令，能看到第一行输出端口号即表示调试端口已正常开启：

  ```sh
  cat ~/Library/Application\ Support/Antigravity/DevToolsActivePort
  ```

### 注意事项

- **程序坞出现两个图标是正常的**：新图标只负责带参数拉起真正的 Antigravity，拉起后自身就会退出，运行中的依然是原版图标。建议把原来常驻的程序坞图标移除，以后只点新图标启动，免得点错。
- **不经过新图标的启动不会带参数**：例如在没有 Antigravity 窗口运行时点 `antigravity://` 链接、从访达「打开方式」冷启动，或 Antigravity 自动更新后自行重启。遇到底栏胶囊消失时，按 `Cmd + Q` 彻底退出后，再用新图标打开一次即可。
- **不要修改 `Antigravity.app` 内部文件**：会破坏应用签名导致无法打开，而且更新后也会被还原。
- **安全说明**：调试端口只监听本机（`--remote-debugging-port=0` 会由系统自动分配空闲本机端口，避免占用固定端口）。打开后，本机上的其他程序也可以通过它控制 Antigravity 窗口；请只在信任的个人电脑上使用。

---

## English

macOS aliases cannot pass command-line flags like Windows shortcuts do. To avoid launching Antigravity from Terminal every time, create a small **launcher icon** once and open Antigravity from it going forward.

### Step 0: Quit Antigravity completely

Press `Cmd + Q` to quit Antigravity.  
Clicking the red close button only closes the window while the app keeps running in the background; if an existing process is still running, newly passed flags are ignored.

### Option 1: Automator app (recommended, works on all macOS versions)

1. Press `Cmd + Space`, search for **Automator**, and open it.
2. Click **New Document** and choose **Application**.
3. Search for **Run Shell Script** on the left and drag it into the workflow area on the right.
4. Replace the default text in the script box (usually `cat`) with:

   ```sh
   open -a "Antigravity" --args --remote-debugging-port=0
   ```

5. Press `Cmd + S`, give it a name (for example, `Antigravity-CDP`), and save it to your **Applications** folder.
6. Double-click this launcher whenever you open Antigravity, or drag it into your Dock.

> **Optional: reuse the Antigravity icon**  
> Select the original `Antigravity` app in Applications and press `Cmd + I`, click the small icon in the top-left corner of the Info window, and press `Cmd + C`. Select your new `Antigravity-CDP` app, press `Cmd + I`, click its top-left icon, and press `Cmd + V`.

### Option 2: Shortcuts (requires macOS 14 Sonoma or later)

1. Open the **Shortcuts** app, go to **Settings → Advanced**, and enable **Allow Running Scripts** (required or the shortcut will fail).
2. Create a new shortcut, add the **Run Shell Script** action, and paste the same command:

   ```sh
   open -a "Antigravity" --args --remote-debugging-port=0
   ```

3. From the menu bar, choose **File → Add to Dock**.

### How to verify

After opening Antigravity with your new launcher:

- The footer capsule appears under the input box and the "Footer capsule is off" banner in the sidebar disappears.
- To double-check from Terminal, run the command below; seeing a port number on the first line confirms the debugging port is active:

  ```sh
  cat ~/Library/Application\ Support/Antigravity/DevToolsActivePort
  ```

### Notes

- **Seeing a second Antigravity icon in the Dock is normal**: the launcher only starts Antigravity with the flag and exits immediately, leaving the real Antigravity icon running. You can remove the original pinned icon from the Dock so you don't click it by mistake.
- **Launches that bypass the launcher won't carry the flag**: opening an `antigravity://` link or using Finder's "Open With" when no window is running, or Antigravity restarting itself after an auto-update. If the capsule disappears, press `Cmd + Q` and reopen via the launcher.
- **Do not edit files inside `Antigravity.app`**: doing so breaks its code signature and will be overwritten by updates.
- **Security**: the debugging port listens on localhost only (`--remote-debugging-port=0` lets the OS pick a free local port to avoid conflicts). While open, other programs on this computer can also control Antigravity windows; use it only on a computer you trust.
