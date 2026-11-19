#!/usr/bin/env sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
exec sh "$SCRIPT_DIR/scripts/manage-plugin.sh" uninstall
