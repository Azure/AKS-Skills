# GPU cost and scaling

Idle GPUs are the dominant AKS cost line. GPU Day-2 cost work is mostly: run at zero when idle, size the SKU to the model, and only use spot where interruption is safe.

## Scale-to-zero

- Enable the cluster autoscaler with `--min-count 0` **at nodepool creation** to let a GPU pool drop to zero when no GPU pod is scheduled. Cold start back up is tens of seconds — keep 1–2 warm replicas during business hours for user-facing chat surfaces.
- The autoscaler only **allows** min 0; it will not **force** a pool to 0. To force it:
  ```bash
  az aks nodepool update -g <rg> --cluster-name <cluster> -n gpunp --disable-cluster-autoscaler
  az aks nodepool scale  -g <rg> --cluster-name <cluster> -n gpunp --node-count 0
  ```
- System node pools cannot scale to 0.
- **Node Auto Provisioning (NAP / Karpenter)** is the smarter multi-SKU alternative to the cluster autoscaler when workloads want different GPU SKUs.

## Right-size the SKU to the model

VRAM ≈ params × bytes/param (fp16 = 2 bytes → a 7B model ≈ ~14 GB of weights, before KV cache and activations). Per-card memory: T4/V100 = 16 GB, A100 = 80 GB, H100 NVL = 94 GB.

- **< ~13B params** → T4/L4 (16 GB).
- **> ~34B params or high QPS** → A100 / H100.
- **4-bit AWQ/GPTQ quantization** fits ~30B into 16 GB.

Publish the KPI **GPU-seconds used vs allocated** (DCGM + Kubernetes context, by namespace) — it exposes the idle GPU spend that dwarfs everything else. Reserved instances can cut up to ~72%; spot 40–90% for batch.

## Spot GPU pools — only where interruption is safe

```bash
az aks nodepool add -g <rg> --cluster-name <cluster> -n gpuspot \
  --node-vm-size Standard_NC24ads_A100_v4 --node-taints sku=gpu:NoSchedule \
  --priority Spot --eviction-policy Delete --spot-max-price -1
```

- Evicted with as little as **30 seconds** notice, no SLA, single fault domain.
- `--eviction-policy Deallocate` leaves stopped-deallocated nodes that **still count against compute quota** and break scaling/upgrade. `priority` and `eviction-policy` are immutable.
- **Never** put user-facing inference on spot — use it only for batch, evaluation, or fine-tuning with checkpointing.

## Autoscale GPU workloads on utilization (KEDA + DCGM)

`nvidia.com/gpu` is integer/non-divisible, so you cannot HPA on "GPU %" natively — scale on DCGM metrics via Managed Prometheus + KEDA:

- `ScaledObject` trigger type `prometheus`, `metricName: DCGM_FI_DEV_GPU_UTIL`, PromQL e.g. `avg(DCGM_FI_DEV_GPU_UTIL{deployment="my-gpu-workload"})`, with `threshold` / `activationThreshold`.
- Requires: the KEDA add-on, Managed Prometheus + Grafana, a `TriggerAuthentication` using Azure Workload Identity, and the KEDA UAMI granted **Monitoring Data Reader** on the Azure Monitor workspace.
- Diagnose: `kubectl describe hpa <name>` → check `ScalingActive` / `AbleToScale` and the `s0-prometheus` external metric.
