#!/bin/sh
# Execute one bounded capture. All artifacts use OUT_DIR, which the Job mounts
# directly from the node, so capture and archive operations share one filesystem.
set -eu

: "${OUT_DIR:?OUT_DIR is required}"
: "${CAPTURE_ID:?CAPTURE_ID is required}"
: "${NODE_NAME:?NODE_NAME is required}"
: "${RUN_ID:?RUN_ID is required}"
: "${CAPTURE_DURATION:?CAPTURE_DURATION is required}"
: "${PACKET_SIZE:?PACKET_SIZE is required}"
: "${PCAP_FILTER:=}"

case "$CAPTURE_ID" in
  ""|-*|*-|*[!a-z0-9-]*) echo "invalid CAPTURE_ID" >&2; exit 2 ;;
esac
[ "${#CAPTURE_ID}" -le 63 ] || { echo "invalid CAPTURE_ID" >&2; exit 2; }
case "$NODE_NAME" in
  ""|*[!A-Za-z0-9._-]*) echo "invalid NODE_NAME" >&2; exit 2 ;;
esac
run_date=${RUN_ID%%-*}
run_remainder=${RUN_ID#*-}
run_time=${run_remainder%%-*}
run_token=${run_remainder#*-}
case "$RUN_ID" in
  ""|*[!0-9a-f-]*) echo "invalid RUN_ID" >&2; exit 2 ;;
esac
[ "${#run_date}" -eq 8 ] && [ "${#run_time}" -eq 6 ] \
  && [ "${#run_token}" -eq 24 ] \
  || { echo "invalid RUN_ID" >&2; exit 2; }
case "$run_date:$run_time" in
  *[!0-9:]*) echo "invalid RUN_ID" >&2; exit 2 ;;
esac
case "$run_token" in
  *[!0-9a-f]*) echo "invalid RUN_ID" >&2; exit 2 ;;
esac

PCAP_NAME="capture-${CAPTURE_ID}-${NODE_NAME}-${RUN_ID}.pcap"
BUNDLE_NAME="capture-${CAPTURE_ID}-${NODE_NAME}-${RUN_ID}.tar.gz"
PCAP_PATH="${OUT_DIR}/${PCAP_NAME}"
BUNDLE_PATH="${OUT_DIR}/${BUNDLE_NAME}"

mkdir -p "$OUT_DIR"

if [ -n "$PCAP_FILTER" ]; then
  tcpdump -d "$PCAP_FILTER" >/dev/null || {
    echo "invalid BPF filter" >&2
    exit 2
  }
fi

set -- tcpdump -i any -w "$PCAP_PATH"
[ "$PACKET_SIZE" -gt 0 ] && set -- "$@" -s "$PACKET_SIZE"
[ -n "$PCAP_FILTER" ] && set -- "$@" "$PCAP_FILTER"

echo "capturing for ${CAPTURE_DURATION}s on ${NODE_NAME}"
if timeout "$CAPTURE_DURATION" "$@"; then
  capture_status=0
else
  capture_status=$?
fi
if [ "$capture_status" -ne 0 ] && [ "$capture_status" -ne 124 ]; then
  echo "tcpdump failed with exit ${capture_status}" >&2
  exit "$capture_status"
fi
[ -s "$PCAP_PATH" ] || {
  echo "tcpdump produced no capture file" >&2
  exit 1
}

tar -C "$OUT_DIR" -czf "$BUNDLE_PATH" "$PCAP_NAME"
rm -f "$PCAP_PATH"
echo "bundle: $BUNDLE_PATH"
