#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/skills/aks-troubleshooting/scripts/cluster-snapshot.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin"
CALLS_FILE="$TMP_DIR/kubectl-calls"
export CALLS_FILE

cat > "$TMP_DIR/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$CALLS_FILE"

case "$*" in
  "get nodes -o wide")
    printf '%s\n' "NAME     STATUS" "node-a   Ready" "node-b   NotReady"
    ;;
  "get nodes -o json")
    cat <<'JSON'
{
  "items": [
    {
      "metadata": {"name": "node-a"},
      "status": {
        "conditions": [
          {"type": "MemoryPressure", "status": "True", "reason": "KubeletHasInsufficientMemory"},
          {"type": "Ready", "status": "True", "reason": "KubeletReady"}
        ]
      }
    },
    {
      "metadata": {"name": "node-b"},
      "status": {
        "conditions": [
          {"type": "DiskPressure", "status": "False", "reason": "KubeletHasNoDiskPressure"},
          {"type": "Ready", "status": "False", "reason": "KubeletNotReady"}
        ]
      }
    }
  ]
}
JSON
    ;;
  "top nodes")
    exit 1
    ;;
esac
EOF
chmod +x "$TMP_DIR/bin/kubectl"

PATH="$TMP_DIR/bin:$PATH" sh "$SCRIPT" > "$TMP_DIR/output"

node_json_calls="$(grep -Fxc 'get nodes -o json' "$CALLS_FILE")"
if [ "$node_json_calls" -ne 1 ]; then
  echo "expected one node JSON fetch, got $node_json_calls" >&2
  cat "$CALLS_FILE" >&2
  exit 1
fi

grep -Fqx $'node-a\tMemoryPressure\tKubeletHasInsufficientMemory' "$TMP_DIR/output"
grep -Fqx $'node-b\tReady\tFalse\tKubeletNotReady' "$TMP_DIR/output"

echo "cluster snapshot reuses one node JSON response for both condition reports"
