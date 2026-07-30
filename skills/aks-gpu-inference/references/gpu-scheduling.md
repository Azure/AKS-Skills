# GPU scheduling, drivers, and quota

## Symptom: GPU pod stuck Pending, "Insufficient nvidia.com/gpu"

Event signature:

```
Warning FailedScheduling  0/2 nodes are available: 2 Insufficient nvidia.com/gpu.
  preemption: 0/2 nodes are available: 2 No preemption victims found.
```

Causes, in likelihood order:

1. **No GPU node exists / pool scaled to 0.** Expected if the autoscaler `min-count` is 0 — wait for `Normal TriggeredScaleUp ... pod triggered scale-up`. If it never scales up, jump to quota.
2. **Taint/toleration mismatch.** The pod is missing the `sku=gpu:NoSchedule` toleration. GPU pods need:
   ```yaml
   tolerations:
   - key: sku
     operator: Equal
     value: gpu
     effect: NoSchedule
   nodeSelector:
     accelerator: nvidia
   resources:
     limits:
       nvidia.com/gpu: 1
   ```
3. **Device plugin not advertising `nvidia.com/gpu`** — see the driver models below.
4. **Quota blocking scale-up** — see quota below.

Check: `kubectl describe pod <pod>`, `kubectl get nodes -o wide`, and `kubectl describe node <gpu-node> | grep -A5 Capacity` for `nvidia.com/gpu`.

## Symptom: node has no `nvidia.com/gpu` (0 capacity/allocatable)

The driver or device plugin is not present. **How AKS provides GPU drivers is the single most confused area** — there are three models:

| Model | How to select | Who installs the device plugin | `nvidia.com/gpu` advertised? |
|-------|---------------|--------------------------------|------------------------------|
| **AKS-managed** (preview, recommended) | `--enable-managed-gpu=true` | AKS (driver + plugin + DCGM + NPD health) | Yes, automatically |
| **Self-managed** (default for N-series) | pass neither flag | **You** deploy the NVIDIA device plugin DaemonSet | Only after you deploy the plugin |
| **NVIDIA GPU Operator** | `--gpu-driver none` | The Operator | After the Operator reconciles |

Key gotchas:
- With the self-managed default, AKS installs the **driver only** — `nvidia.com/gpu` does **not** appear until you deploy a device plugin (image `nvcr.io/nvidia/k8s-device-plugin`, tolerating `sku=gpu:NoSchedule`).
- `--enable-managed-gpu=true` **ignores** `--gpu-driver none` (managed mode requires the driver).
- `gpuProfile` fields (`managementMode`, `migStrategy`, `driver`) are **immutable at creation** — to change the model you must create a new node pool. Verify: `az aks nodepool show ... --query gpuProfile`.
- The `--skip-gpu-driver-install` node-pool **tag is retired** (Aug 14, 2025). Use the API field `--gpu-driver none`, settable **only at nodepool add** (persists across upgrades; passing it to update/upgrade errors). Needs a recent Azure CLI (`--gpu-driver` unrecognized → CLI too old).

Check: `kubectl describe node <node>` (Capacity/Allocatable), `kubectl get pods -n kube-system | grep -i nvidia`, `az aks nodepool show ... --query gpuProfile` (expect `driver: Install`).

## Symptom: CUDA / driver version mismatch

Signature: `CUDA driver version is insufficient for CUDA runtime version`. The container's CUDA runtime is newer than the node driver. Fix per the NVIDIA driver/CUDA compatibility matrix; self-managed → align plugin/driver; GPU Operator → pin the driver version. AKS-managed pools avoid this by managing driver + plugin together.

## Symptom: node pool creation / scale-up fails on quota

Root facts: every N-series family defaults to **0 vCPUs in every region**, and quota is counted in **vCPUs, not GPU count**. Signatures: *"Insufficient vCPU quota for Standard NCASv3_T4 Family in East US"*, *"Insufficient vcpu quota requested 6, remaining 0 for family standardNCSv3Family"*.

Exact checks:

```bash
# Per-family vCPU usage vs limit (family localName rows)
az vm list-usage --location "<region>" -o table
#   e.g. "Standard NC Family vCPUs", "Standard NCv3 Family vCPUs",
#        "Standard NCADSA100v4 Family vCPUs", "Standard NCadsH100v5 Family vCPUs"

# Modern Microsoft.Quota API (requires RP registration + Quota Request Operator role)
az quota show --resource-name standardNCADSA100v4Family \
  --scope subscriptions/<sub>/providers/Microsoft.Compute/locations/<region>
```

Then remember the three separate walls with the same symptom: **quota** (raise via a support/quota request), **capacity** (region/zone may physically lack the GPU — try another region/zone), and **SKU eligibility** (some GPU SKUs need a separate eligibility ticket even with quota). Confirm what is actually creatable with `az vm list-skus --location <region> --resource-type virtualMachines -o table`.

> The exact A100/H100 quota family localName spacing can vary — confirm the live string per subscription with `az vm list-usage`. (Azure ML has a known bug validating H100 v5 against the wrong family name.)

## GPU SKU quick reference (per-card memory drives OOM math)

| SKU family | GPU | Per-card memory | Use |
|------------|-----|-----------------|-----|
| Standard_NC4as_T4_v3 | 1× T4 | 16 GB | AKS minimum supported GPU; models < ~13B |
| Standard_NC*s_v3 | V100 | 16 GB | NCv3 (retiring) |
| Standard_NC*ads_A100_v4 | A100 (PCIe) | 80 GB | Inference for larger models / high QPS |
| Standard_NC*ads_H100_v5 | H100 NVL | 94 GB | Net-new NC capacity; large models |
| Standard_ND*_v4/v5 | 8× A100/H100 + InfiniBand | 80 GB | Training / multi-GPU (avoid for inference) |

NVv4 (AMD GPU) is **not** supported on AKS; NV-series (NVIDIA) is visualization-oriented and not recommended for GPU pools. Both Ubuntu and Azure Linux support NVIDIA GPU, but Azure Linux GPU pools get **no automatic security patches**, and you cannot add a GPU VM size to an existing pool — create a new one.
