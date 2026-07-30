# GPU observability and OOM

## The two facts that trip people up

1. **DCGM exporter port depends on the install model.** AKS-**managed** GPU pools expose the DCGM metrics exporter on **port 19400**; NVIDIA upstream and the GPU Operator use **9400**. A command copied from NVIDIA docs (`:9400`) returns nothing on a managed pool.
2. **Kubernetes has no native GPU-memory-pressure signal.** VRAM exhaustion never shows as a Kubernetes "memory pressure" event — it surfaces only as a container **OOMKilled (exit 137)**, *after* DCGM VRAM telemetry already shows the trend. So watch DCGM proactively and size up front.

## Live inspection

```bash
# nvidia-smi inside a running GPU pod (utilization + VRAM, per process)
kubectl exec -it <gpu-pod> -- nvidia-smi

# Scrape the DCGM exporter directly (managed = 19400, upstream/GPU-Operator = 9400)
kubectl exec -n kube-system <dcgm-exporter-pod> -- \
  curl -s localhost:19400/metrics | grep -E "DCGM_FI_DEV_(GPU_UTIL|FB_USED|FB_FREE|POWER_USAGE|XID_ERRORS)"
```

## Enable managed scraping (Azure Managed Prometheus)

```bash
kubectl apply -f - <<'EOF'
kind: ConfigMap
apiVersion: v1
metadata:
  name: ama-metrics-settings-configmap
  namespace: kube-system
data:
  schema-version: v1
  config-version: ver1
  default-scrape-settings-enabled: |-
    dcgmexporter = true
EOF
```

Then use the Azure-managed Grafana dashboard **"Kubernetes | NVIDIA GPU DCGM Exporter"**.

## Metrics that matter

| Metric | Meaning | Watch for |
|--------|---------|-----------|
| `DCGM_FI_DEV_GPU_UTIL` | % of time a kernel was active | Utilization — but not efficiency (see below) |
| `DCGM_FI_DEV_FB_USED` / `FB_FREE` | VRAM used / free (bytes) | The OOM canary — trend toward 0 free before a crash |
| `DCGM_FI_DEV_MEMORY_UTIL` | Memory-controller utilization | Memory-bound workloads |
| `DCGM_FI_PROF_SM_ACTIVE` / `DCGM_FI_PROF_DRAM_ACTIVE` | SM vs DRAM activity | Correlate to tell compute-bound from memory-bound (may be absent on some SKUs) |
| `DCGM_FI_DEV_POWER_USAGE` | Power draw | A sudden drop = thermal/power throttle |
| `DCGM_FI_DEV_TEMPERATURE` | GPU temperature | Throttle threshold |
| `DCGM_FI_DEV_XID_ERRORS` | NVIDIA XID errors | Critical — can taint the node |

`DCGM_FI_DEV_GPU_UTIL` reports kernel-active time, **not** efficiency — a workload can show 100% util while being memory-bound and slow. Correlate `SM_ACTIVE` with `DRAM_ACTIVE` to distinguish.

## Model OOMKilled loading weights

Signature: pod `State/Reason = OOMKilled`, exit code 137, during model load.

```bash
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[*].lastState.terminated.reason} {.status.containerStatuses[*].lastState.terminated.exitCode}'
```

Cause: model weights (plus KV cache and activations) exceed the card's VRAM. Fix by right-sizing the SKU to the model (see gpu-cost-and-scaling.md) or quantizing — not by blindly raising limits, since the ceiling is physical GPU memory. Confirm the VRAM trend with `DCGM_FI_DEV_FB_USED` leading up to the kill.
