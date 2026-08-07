#!/usr/bin/env bash
# setup-capture-configmap.sh — Deploy the fixed capture runner
# Run this once before creating any capture jobs
set -euo pipefail

NAMESPACE="${1:-default}"
CONFIGMAP_NAME="network-capture-scripts"

case "$NAMESPACE" in
  ""|-*|*-) echo "Error: namespace must be an RFC 1123 label" >&2; exit 1 ;;
  *[!a-z0-9-]*) echo "Error: namespace must be an RFC 1123 label" >&2; exit 1 ;;
esac
[ "${#NAMESPACE}" -le 63 ] || { echo "Error: namespace must be at most 63 characters" >&2; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo "Error: kubectl not found on PATH" >&2; exit 1; }

echo "Creating ConfigMap: $CONFIGMAP_NAME in namespace: $NAMESPACE"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

kubectl create configmap "$CONFIGMAP_NAME" \
  --from-file=run-capture.sh="$SCRIPT_DIR/run-capture.sh" \
  --namespace="$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "ConfigMap created/updated successfully!"
echo ""
echo "You can now create capture jobs using:"
echo "  ./scripts/create-capture.sh --name my-capture --namespace $NAMESPACE --duration 60s"
echo ""
echo "To update the ConfigMap with script changes, run this setup again."
