#!/usr/bin/env bash
# generate-test-traffic.sh — Generate bounded test traffic from a pod's network namespace.
#
# Safe-by-construction: --target and --target-port are validated, then passed to a FIXED
# in-pod script as POSITIONAL ARGUMENTS ($1/$2). User data is never interpolated into a
# shell command string, so there is no injection path and no `eval`. The ephemeral debug
# container uses a digest-pinned MCR image and runs non-interactively.
set -euo pipefail

DEBUG_IMAGE="mcr.microsoft.com/cbl-mariner/busybox:2.0@sha256:e4fb4d51fc9b70d6cdc1ce66a0af02ab40554d2ca632e1d188fabc760e432fdd"

TRAFFIC_TYPE="http"
TARGET=""
TARGET_PORT=""
SOURCE_POD=""
SOURCE_NAMESPACE="default"
DURATION="30s"
INTERVAL="1"

usage() {
  cat <<EOF
Usage: $0 --source-pod <pod> --target <ip|hostname> [options]

Required:
  --source-pod <name>        Pod to generate traffic from (RFC 1123 name)
  --target <ip|hostname>     Target IP or hostname

Options:
  --type <type>              http | https | dns | tcp | ping (default: http)
  --target-port <1-65535>    Target port (default: 80/443/53 by type; required for tcp)
  --source-namespace <ns>    Source pod namespace (default: default)
  --duration <Ns|Nm|Nh>      How long to generate traffic (default: 30s, max 1h)
  --interval <seconds>       Whole seconds between requests (default: 1)

Examples:
  $0 --source-pod frontend-abc123 --target backend.default.svc.cluster.local
  $0 --source-pod app-xyz --source-namespace production --target 10.244.0.5 --target-port 8080 --type tcp
EOF
  exit 1
}

die() { echo "Error: $*" >&2; exit 1; }
valid_rfc1123() { printf '%s' "$1" | grep -Eq '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'; }
# Host = IPv4/IPv6/DNS name: letters, digits, dot, dash, colon (v6) only.
valid_host() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._:-]+$'; }
valid_uint() { printf '%s' "$1" | grep -Eq '^[0-9]+$'; }
valid_duration() { printf '%s' "$1" | grep -Eq '^[0-9]+[smh]$'; }
duration_to_seconds() {
  local d="$1" n unit; n="${d%[smh]}"; unit="${d##*[0-9]}"
  case "$unit" in s) echo "$n";; m) echo "$((n*60))";; h) echo "$((n*3600))";; esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source-pod) SOURCE_POD="${2:-}"; shift 2 ;;
    --source-namespace) SOURCE_NAMESPACE="${2:-}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    --target-port) TARGET_PORT="${2:-}"; shift 2 ;;
    --type) TRAFFIC_TYPE="${2:-}"; shift 2 ;;
    --duration) DURATION="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

[ -n "$SOURCE_POD" ] && [ -n "$TARGET" ] || die "--source-pod and --target are required"
valid_rfc1123 "$SOURCE_POD" || die "--source-pod must be an RFC 1123 name"
valid_rfc1123 "$SOURCE_NAMESPACE" || die "--source-namespace must be an RFC 1123 name"
valid_host "$TARGET" || die "--target has invalid characters"
valid_duration "$DURATION" || die "--duration must look like 30s, 5m, or 1h"
DUR_SECONDS="$(duration_to_seconds "$DURATION")"
[ "$DUR_SECONDS" -ge 1 ] && [ "$DUR_SECONDS" -le 3600 ] || die "--duration must be 1s..1h"
valid_uint "$INTERVAL" || die "--interval must be a non-negative integer"

case "$TRAFFIC_TYPE" in
  dns) TARGET_PORT="${TARGET_PORT:-53}" ;;
  https) TARGET_PORT="${TARGET_PORT:-443}" ;;
  http) TARGET_PORT="${TARGET_PORT:-80}" ;;
  tcp) [ -n "$TARGET_PORT" ] || die "--target-port is required for tcp" ;;
  ping) TARGET_PORT="0" ;;
  *) die "--type must be one of: http https dns tcp ping" ;;
esac
valid_uint "$TARGET_PORT" || die "--target-port must be an integer"
[ "$TARGET_PORT" -le 65535 ] || die "--target-port out of range"

# Fixed in-pod script: reads target/port/duration/interval as POSITIONAL args ($1..$4).
# No user data is interpolated into this text — it is a constant single-quoted string.
POD_SCRIPT='
set -u
target="$1"; port="$2"; dur="$3"; iv="$4"; type="$5"
# Bracket IPv6 literals for URL use (a bare colon in the host is IPv6, never a hostname/IPv4).
case "$target" in *:*) urlhost="[$target]";; *) urlhost="$target";; esac
end=$(( $(date +%s) + dur ))
while [ "$(date +%s)" -lt "$end" ]; do
  case "$type" in
    http)  wget -q -O /dev/null -T 5 "http://$urlhost:$port/"  && echo "http ok"  || echo "http fail" ;;
    https) wget -q -O /dev/null -T 5 --no-check-certificate "https://$urlhost:$port/" && echo "https ok" || echo "https fail" ;;
    dns)   nslookup "$target" >/dev/null 2>&1 && echo "dns ok" || echo "dns fail" ;;
    tcp)   nc -z -w 5 "$target" "$port" && echo "tcp ok" || echo "tcp fail" ;;
    ping)  ping -c 1 -W 5 "$target" >/dev/null 2>&1 && echo "ping ok" || echo "ping fail" ;;
  esac
  [ "$iv" -gt 0 ] && sleep "$iv"
done
'

echo "Generating $TRAFFIC_TYPE traffic from $SOURCE_POD to $TARGET${TARGET_PORT:+:$TARGET_PORT} for ${DUR_SECONDS}s"
command -v kubectl >/dev/null 2>&1 || die "kubectl not found on PATH"

# Pass user values only as trailing positional arguments (safe: never in the script text).
if kubectl exec -n "$SOURCE_NAMESPACE" "$SOURCE_POD" -- sh -c 'exit 0' >/dev/null 2>&1; then
  kubectl exec -n "$SOURCE_NAMESPACE" "$SOURCE_POD" -- \
    sh -c "$POD_SCRIPT" _ "$TARGET" "$TARGET_PORT" "$DUR_SECONDS" "$INTERVAL" "$TRAFFIC_TYPE"
else
  echo "Direct exec unavailable; using an ephemeral debug container sharing the pod netns."
  target_container="$(kubectl get pod -n "$SOURCE_NAMESPACE" "$SOURCE_POD" -o jsonpath='{.spec.containers[0].name}')"
  kubectl debug -n "$SOURCE_NAMESPACE" "$SOURCE_POD" \
    --image="$DEBUG_IMAGE" --target="$target_container" -q -- \
    sh -c "$POD_SCRIPT" _ "$TARGET" "$TARGET_PORT" "$DUR_SECONDS" "$INTERVAL" "$TRAFFIC_TYPE"
fi
echo "Traffic generation complete"
