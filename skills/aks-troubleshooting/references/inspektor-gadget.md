# Inspektor Gadget (IG) Reference

Use Inspektor Gadget for real-time, low-level node/pod diagnostics when `kubectl` is insufficient.

## Contents

- [Verified Image](#verified-image)
- [Run Script](#run-script)
- [Validated Filters](#validated-filters)
- [Gadget Catalog](#gadget-catalog)
- [Symptom-to-Gadget Map](#symptom-to-gadget-map)
- [Gadget Type Reference](#gadget-type-reference)
- [Guardrails](#guardrails)

## Verified Image

`run-ig` pins official non-prerelease release `v0.51.0` to the verified
multi-architecture OCI index:

`mcr.microsoft.com/oss/v2/inspektor-gadget/ig:v0.51.0@sha256:6610863f6d8cae28800f9331756434639bca44be065719cbcfe76e34c91dffa4`

The index contains Linux `amd64` and `arm64` manifests. The scripts do not
accept a tag or version override.

## Run Script

```bash
scripts/run-ig.sh \
  --subscription <subscription-id> \
  --resource-group <resource-group> \
  --cluster <cluster-name> \
  --context <kube-context> \
  --artifacts-dir <new-empty-directory> \
  --namespace <namespace> \
  --gadget trace_dns --pod <pod-name> \
  --dry-run
```

For a real run, replace `--dry-run` with `--approve-privileged` and an explicit
`--deadline <duration>`. PowerShell exposes equivalent parameters through
[`run-ig.ps1`](../scripts/run-ig.ps1). The script resolves a pod's node only
after target proof, injects a unique run marker, discovers the exact generated
debug pod, and requests its deletion in cleanup handlers.

Raw gadget output remains in the artifact directory. Model-visible output is a
safe projection of target, gadget, approved filters, completion, cleanup, raw
artifact path, and hash.

## Validated Filters

Arbitrary argument passthrough is not supported.

| Script option | Accepted scope |
|---|---|
| `--container` / `-Container` | Validated workload container name |
| `--timeout` / `-Timeout` | Positive seconds; defaults remain 5 for snapshot/top and 30 for trace/profile/tcpdump |
| `--max-entries` / `-MaxEntries` | Positive integer for top/profile gadgets |
| `--map-fetch-interval` / `-MapFetchInterval` | Validated duration for top/profile except `top_process` |
| `--interval` / `-Interval` | Validated duration for `top_process` only |
| `--syscall-filters` / `-SyscallFilters` | Required validated comma-list for `traceloop`; rejected elsewhere |
| `--packet-filter` / `-PacketFilter` | Restricted packet-filter grammar for `tcpdump`; rejected elsewhere |

## Gadget Catalog

### Networking

| Gadget | Type | What It Does | When To Use |
|---|---|---|---|
| `trace_dns` | trace | Trace DNS queries and responses with latency | DNS failures, NXDOMAIN, SERVFAIL, slow resolution, intermittent DNS |
| `trace_tcp` | trace | Trace TCP connect/accept/close events | Connection refused, timeouts, unexpected drops, mapping pod connectivity |
| `trace_tcpretrans` | trace | Trace TCP retransmissions | Network congestion, lossy links, high latency between pods/services |
| `trace_bind` | trace | Trace socket bind calls | Port conflicts, address-already-in-use errors |
| `trace_sni` | trace | Trace TLS SNI (Server Name Indication) values | HTTPS routing issues, ingress TLS debugging, mTLS problems |
| `snapshot_socket` | snapshot | List open sockets (TCP/UDP/Unix) | Port conflicts, listening ports, connection leaks, ECONNREFUSED |
| `tcpdump` | special | Capture raw packets in pcap-ng format | Deep packet inspection, protocol-level debugging, reproducing network issues |

#### tcpdump gadget

`run-ig` stores pcap-ng output as a raw artifact and never pipes packet payloads
into model context. Use the validated packet-filter option to constrain capture.

### Process & Workload

| Gadget | Type | What It Does | When To Use |
|---|---|---|---|
| `snapshot_process` | snapshot | List running processes in pod/node | PID pressure, unknown processes, verifying entrypoint, CrashLoopBackOff |
| `trace_exec` | trace | Trace process execution (execve calls) | CrashLoopBackOff (what actually runs), unexpected child processes, security audit |
| `trace_oomkill` | trace | Trace OOM kill events with victim details | OOMKilled pods — see which process was killed, memory usage at kill time |
| `trace_signal` | trace | Trace signals delivered to processes | Unexpected SIGKILL/SIGTERM, liveness probe kills, graceful shutdown issues |
| `top_process` | top | Rank processes by CPU/memory usage | Identifying resource-hungry processes inside a pod or across a node |
| `profile_cpu` | profile | CPU profiling via stack sampling | High CPU usage investigation, finding hot code paths |
| `traceloop` | trace | Record syscalls as a flight recorder | Catch-all for intermittent issues. **Always use `--syscall-filters`** (e.g., `open,connect,accept`) to limit data volume |

### File & Storage

| Gadget | Type | What It Does | When To Use |
|---|---|---|---|
| `trace_open` | trace | Trace openat syscall | Missing config/secret files (ENOENT), permission denied (EACCES), startup failures |
| `trace_fsslower` | trace | Trace slow filesystem operations | Slow disk I/O, PVC performance issues, NFS/Azure Disk latency |
| `top_file` | top | Rank files by read/write activity | Identifying I/O-heavy files, noisy log writers, disk pressure diagnosis |

### Security & Audit

| Gadget | Type | What It Does | When To Use |
|---|---|---|---|
| `trace_capabilities` | trace | Trace Linux capability checks | Permission denied from dropped capabilities, SecurityContext debugging |

## Symptom-to-Gadget Map

| Symptom | Gadget(s) |
|---|---|
| DNS resolution failures | `trace_dns` |
| Connection refused / timeout | `trace_tcp` + `snapshot_socket` |
| Silent connection drops | `trace_tcpretrans` |
| High network latency | `trace_tcpretrans` |
| TLS / HTTPS routing issues | `trace_sni` |
| Port already in use | `trace_bind` + `snapshot_socket` |
| CrashLoopBackOff (unknown cause) | `trace_exec` + `trace_open` |
| OOMKilled pods | `trace_oomkill` + `top_process` |
| Pod killed unexpectedly | `trace_signal` |
| PID pressure on node | `snapshot_process` + `top_process` |
| "Too many open files" | `top_file` |
| Missing config / secret mount | `trace_open` |
| Slow disk / PVC performance | `trace_fsslower` + `top_file` |
| Permission denied (capabilities) | `trace_capabilities` |
| High CPU (unknown cause) | `profile_cpu` + `top_process` |
| Deep packet inspection | `tcpdump` |
| Catch-all / intermittent issues | `traceloop` (use `--syscall-filters`) |

## Gadget Type Reference

| Type | Behavior | IG --timeout |
|---|---|---|
| `snapshot` | Point-in-time data, returns immediately | `--timeout 5` |
| `top` | Aggregated view, returns quickly | `--timeout 5` |
| `trace` | Streams events in real-time | `--timeout 30` |
| `profile` | Samples over a duration | `--timeout 30` |
| `tcpdump` | Streams pcap-ng data, pipe to `tcpdump -nvr -` | `--timeout 30` |

## Guardrails

- Gadget observation is read-only, but creating a privileged debug pod is a
  cluster mutation. Require explicit approval and sufficient RBAC.
- Prove subscription/resource group/cluster/context identity before resolving a
  node or creating the debug pod.
- Use only the digest-pinned scripts; do not assemble `kubectl debug` manually.
- Require a caller-supplied overall deadline for real execution. The script
  requests deletion of the exact marked debug pod on success, failure, timeout,
  or interruption and fails if cleanup cannot be confirmed.
- Keep raw IG/pcap output outside model context. Use the path and hash in the
  safe projection for authorized human or offline review.
