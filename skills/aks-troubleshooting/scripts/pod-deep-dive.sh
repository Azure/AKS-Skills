#!/usr/bin/env bash
# Compatibility entry point. Uses the target-bound pod evidence contract.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$SCRIPT_DIR/pod-evidence.sh" "$@"
