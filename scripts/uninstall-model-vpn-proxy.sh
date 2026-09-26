#!/bin/bash
# Compatibility entry point; implementation is shared with Windows.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${NODE_BIN:-node}" "$SCRIPT_DIR/model-vpn-proxy-service.mjs" uninstall "$@"
