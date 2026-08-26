#!/bin/sh
# pod-deep-dive.sh — Target-bound, model-safe diagnostic evidence for one pod.
# Usage: pod-deep-dive.sh <namespace> <pod> <resource-group> <cluster> <context> <new-artifacts-dir>
set -eu

export AZURE_HTTP_USER_AGENT="${AZURE_HTTP_USER_AGENT:+$AZURE_HTTP_USER_AGENT }AKS-Skills"

NS="${1:-}"
POD="${2:-}"
RG="${3:-${AKS_RESOURCE_GROUP:-}}"
CLUSTER="${4:-${AKS_CLUSTER_NAME:-}}"
CONTEXT="${5:-${AKS_KUBE_CONTEXT:-}}"
ARTIFACTS_DIR="${6:-${AKS_ARTIFACTS_DIR:-}}"
SUBSCRIPTION="${AKS_SUBSCRIPTION_ID:-}"
LOG_TAIL_LINES=50

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found on PATH"
}

normalize_endpoint() {
  printf '%s' "$1" |
    tr '[:upper:]' '[:lower:]' |
    sed -E 's#^[a-z]+://##; s#/.*$##; s#:[0-9]+$##; s/\.$//'
}

read_aks_target() {
  if [ -n "$SUBSCRIPTION" ]; then
    az aks show --subscription "$SUBSCRIPTION" \
      --resource-group "$RG" --name "$CLUSTER" -o json
  else
    az aks show --resource-group "$RG" --name "$CLUSTER" -o json
  fi
}

kube() {
  kubectl --context "$CONTEXT" "$@"
}

redact_evidence() {
  awk '
    BEGIN { private_key = 0 }
    {
      lower = tolower($0)
      if (lower ~ /-----begin [a-z0-9 ]*private key-----/) {
        print "[REDACTED PRIVATE KEY BLOCK]"
        private_key = 1
        next
      }
      if (private_key) {
        if (lower ~ /-----end [a-z0-9 ]*private key-----/) private_key = 0
        next
      }

      line = $0
      lower = tolower(line)
      if (match(lower, /authorization[[:space:]]*:/)) {
        line = substr(line, 1, RSTART + RLENGTH - 1) " [REDACTED]"
      } else if (match(lower, /bearer[[:space:]]+[a-z0-9._~+\/=-]+/)) {
        line = substr(line, 1, RSTART - 1) "******"
      }

      lower = tolower(line)
      if (match(lower, /([a-z0-9]+[-_]key|password|passwd|pwd|token|secret|credentials?|api[-_]?key|client[-_]?secret|connection[-_]?string|sas|signature|cookie|set-cookie|accountkey|sharedaccesskey|sharedaccesssignature)"?[[:space:]]*[:=][[:space:]]*/)) {
        line = substr(line, 1, RSTART + RLENGTH - 1) "[REDACTED]"
      }

      gsub(/:\/\/[^\/[:space:]@]+:[^\/[:space:]@]+@/, "://[REDACTED]@", line)

      prefix = ""
      remaining = line
      lower_remaining = tolower(remaining)
      while (match(lower_remaining, /[?&]sig=[^&[:space:]#]+/)) {
        matched = substr(remaining, RSTART, RLENGTH)
        equals_at = match(matched, /=/)
        prefix = prefix substr(remaining, 1, RSTART - 1) \
          substr(matched, 1, equals_at) "[REDACTED]"
        remaining = substr(remaining, RSTART + RLENGTH)
        lower_remaining = tolower(remaining)
      }
      print prefix remaining
    }
  '
}

collect_raw() {
  name="$1"
  shift
  path="$ARTIFACTS_DIR/$name.raw.txt"
  if "$@" >"$path" 2>&1; then
    chmod 600 "$path"
    return 0
  fi
  chmod 600 "$path"
  return 1
}

print_redacted() {
  heading="$1"
  path="$2"
  echo ""
  echo "--- $heading ---"
  redact_evidence <"$path"
}

collect_logs() {
  mode="$1"
  path="$ARTIFACTS_DIR/logs-$mode.raw.txt"
  if [ "$mode" = "previous" ]; then
    if ! kube logs "$POD" -n "$NS" --all-containers=true --prefix=true \
      --previous --tail="$LOG_TAIL_LINES" >"$path" 2>&1; then
      chmod 600 "$path"
      echo ""
      echo "--- Previous Logs (all containers, redacted, last $LOG_TAIL_LINES lines) ---"
      echo "(no previous logs; raw command output retained)"
      return
    fi
    heading="Previous Logs"
  else
    if ! kube logs "$POD" -n "$NS" --all-containers=true --prefix=true \
      --tail="$LOG_TAIL_LINES" >"$path" 2>&1; then
      chmod 600 "$path"
      echo ""
      echo "--- Current Logs (all containers, redacted, last $LOG_TAIL_LINES lines) ---"
      echo "(no current logs; raw command output retained)"
      return
    fi
    heading="Current Logs"
  fi
  chmod 600 "$path"
  echo ""
  echo "--- $heading (all containers, redacted, last $LOG_TAIL_LINES lines) ---"
  redact_evidence <"$path" | sed -n "1,${LOG_TAIL_LINES}p"
}

[ -n "$NS" ] && [ -n "$POD" ] && [ -n "$RG" ] &&
  [ -n "$CLUSTER" ] && [ -n "$CONTEXT" ] && [ -n "$ARTIFACTS_DIR" ] ||
  die "usage: pod-deep-dive.sh <namespace> <pod> <resource-group> <cluster> <context> <new-artifacts-dir>"

case "$ARTIFACTS_DIR" in
  / | "") die "invalid artifacts directory" ;;
esac
[ ! -L "$ARTIFACTS_DIR" ] || die "artifacts directory must not be a symlink"
if [ -e "$ARTIFACTS_DIR" ] && [ ! -d "$ARTIFACTS_DIR" ]; then
  die "artifacts path is not a directory"
fi
mkdir -p "$ARTIFACTS_DIR"
if [ -n "$(find "$ARTIFACTS_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  die "artifacts directory must be empty"
fi
chmod 700 "$ARTIFACTS_DIR"
ARTIFACTS_DIR="$(cd "$ARTIFACTS_DIR" && pwd -P)" ||
  die "artifacts directory is inaccessible"

require_command az
require_command jq
require_command kubectl

if ! AKS_JSON="$(read_aks_target 2>/dev/null)"; then
  die "AKS resource target is inaccessible"
fi
PUBLIC_FQDN="$(printf '%s\n' "$AKS_JSON" | jq -r '.fqdn // empty')"
PRIVATE_FQDN="$(printf '%s\n' "$AKS_JSON" | jq -r '.privateFqdn // empty')"
if ! KUBE_SERVER="$(kube config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null)"; then
  die "kube context is inaccessible"
fi

KUBE_HOST="$(normalize_endpoint "$KUBE_SERVER")"
PUBLIC_HOST="$(normalize_endpoint "$PUBLIC_FQDN")"
PRIVATE_HOST="$(normalize_endpoint "$PRIVATE_FQDN")"
if [ -z "$KUBE_HOST" ] ||
  { [ "$KUBE_HOST" != "$PUBLIC_HOST" ] && [ "$KUBE_HOST" != "$PRIVATE_HOST" ]; }; then
  die "kube context does not target the named AKS cluster"
fi

echo "=== Pod Deep Dive: $NS/$POD $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "targetProof=matched cluster=$RG/$CLUSTER context=$CONTEXT"
echo "rawArtifacts=$ARTIFACTS_DIR"

if ! collect_raw pod-status kube get pod "$POD" -n "$NS" -o wide; then
  die "pod not found"
fi
print_redacted "Pod Status" "$ARTIFACTS_DIR/pod-status.raw.txt"

if collect_raw pod-describe kube describe pod "$POD" -n "$NS"; then
  echo ""
  echo "--- Describe ---"
  echo "(raw describe retained outside model output)"
else
  echo ""
  echo "--- Describe ---"
  echo "(describe unavailable; raw command output retained)"
fi

POD_JSON="$ARTIFACTS_DIR/pod.raw.json"
if kube get pod "$POD" -n "$NS" -o json >"$POD_JSON" 2>&1; then
  chmod 600 "$POD_JSON"
  echo ""
  echo "--- Container Resources ---"
  jq '.spec.containers[] | {name, resources}' "$POD_JSON" 2>/dev/null |
    redact_evidence || echo "(unable to project resources)"
else
  chmod 600 "$POD_JSON"
  echo ""
  echo "--- Container Resources ---"
  echo "(resource data unavailable; raw command output retained)"
fi

collect_logs current
collect_logs previous

if collect_raw pod-events kube get events -n "$NS" \
  --field-selector "involvedObject.name=$POD" --sort-by='.lastTimestamp'; then
  print_redacted "Events" "$ARTIFACTS_DIR/pod-events.raw.txt"
else
  echo ""
  echo "--- Events ---"
  echo "(events unavailable; raw command output retained)"
fi

if collect_raw pod-usage kube top pod "$POD" -n "$NS" --containers; then
  print_redacted "Resource Usage" "$ARTIFACTS_DIR/pod-usage.raw.txt"
else
  echo ""
  echo "--- Resource Usage ---"
  echo "(metrics unavailable; raw command output retained)"
fi

echo ""
echo "=== End Deep Dive ==="
