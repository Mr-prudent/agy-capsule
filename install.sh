#!/usr/bin/env sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
sh "$SCRIPT_DIR/scripts/manage-plugin.sh" install
printf '[English]\n%s\n[中文]\n%s\n' \
    'Footer capsule: newer Antigravity versions need --remote-debugging-port=0 at launch, e.g. open -a Antigravity --args --remote-debugging-port=0 (see README).' \
    '底栏胶囊：新版 Antigravity 需要带上 --remote-debugging-port=0 启动，例如 open -a Antigravity --args --remote-debugging-port=0（见 README）。'
