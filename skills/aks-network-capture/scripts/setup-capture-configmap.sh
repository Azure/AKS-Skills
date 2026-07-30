#!/bin/bash
# setup-capture-configmap.sh — Deploy ConfigMap with network collection script
# Run this once before creating any capture jobs
set -e

NAMESPACE="${1:-default}"
CONFIGMAP_NAME="network-capture-scripts"

echo "Creating ConfigMap: $CONFIGMAP_NAME in namespace: $NAMESPACE"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

kubectl create configmap "$CONFIGMAP_NAME" \
  --from-file=collect-network-info.sh="$SCRIPT_DIR/collect-network-info.sh" \
  --namespace="$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "ConfigMap created/updated successfully!"
echo ""
echo "You can now create capture jobs using:"
echo "  ./scripts/create-capture.sh --name my-capture --duration 60s"
echo ""
echo "To update the ConfigMap with script changes, run this setup again."
