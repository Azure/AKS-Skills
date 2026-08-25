#!/usr/bin/env bash
# Compatibility entry point. Uses the target-bound baseline contract.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$SCRIPT_DIR/aks-baseline.sh" "$@"
