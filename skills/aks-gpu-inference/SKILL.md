---
name: aks-gpu-inference
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
  capabilities:
    - id: azure.aks.cluster.read
      mode: preferred
    - id: azure.aks.nodepool.read
      mode: preferred
    - id: azure.compute.quota.read
      mode: conditional
      when: diagnosing an Azure GPU vCPU quota failure
    - id: kubernetes.resources.read
      mode: live-only
  openclaw:
    emoji: "🎛️"
    requires:
      anyBins:
        - kubectl
        - az
description: "Day-2 operations for GPU and model-inference workloads on Azure Kubernetes Service (AKS): diagnose GPU pods stuck Pending, missing nvidia.com/gpu, CUDA/driver mismatches, model OOM on weight load, GPU vCPU-quota failures, KAITO (AI toolchain operator) Workspaces stuck not-ready, and GPU cost / scale-to-zero / spot eviction. WHEN: GPU pod Pending 'Insufficient nvidia.com/gpu', no nvidia.com/gpu on node, CUDA driver version insufficient, model OOMKilled loading weights, GPU node pool quota exceeded, KAITO Workspace never becomes ready, idle GPU cost, autoscale GPU on DCGM, spot GPU eviction, right-size a GPU SKU for a model. DO NOT USE FOR: initial GPU/AI setup or enablement (use azure-skills airunway-aks-setup); non-GPU pod/node/network incidents (use aks-troubleshooting); non-GPU cost (use aks-cost-optimization)."
---

# AKS GPU & Inference (Day-2)

Operate and troubleshoot GPU and model-serving workloads on AKS after they exist. This is the failure → check → fix loop, not a setup guide — for enabling GPUs, KAITO, or a model runway, use `azure-skills airunway-aks-setup`.

## Operating rules

- **Read-only by default.** Diagnose and propose; do not scale, cordon, delete node pools, or delete KAITO Workspaces unless the user explicitly asks — deleting a Workspace has a cost trap (below).
- **Evidence before conclusion.** GPU symptoms have layered causes (quota → capacity → scheduling → driver). Quote the event, node capacity, or condition that supports the root cause.

## The four walls (check in this order)

Most "my GPU workload won't run" incidents are one of these, and they stack — clearing one exposes the next:

1. **GPU quota is 0 by default.** Every N-series VM family starts at **0 vCPUs in every region**, and quota is measured in **vCPUs, not GPUs**. Check: `az vm list-usage --location <region> -o table` and look for the family row (e.g. `Standard NC Family vCPUs`, `Standard NCADSA100v4 Family vCPUs`). Error signature: *"Insufficient vCPU quota for Standard NCASv3_T4 Family…"*.
2. **Quota ≠ capacity ≠ SKU-eligibility.** Even with quota, a region/zone can lack physical GPU capacity, and AKS gates some GPU SKUs behind a separate eligibility ticket. Check what's actually creatable: `az vm list-skus --location <region> --resource-type virtualMachines -o table`.
3. **The taint/toleration/nodeSelector triad.** GPU pools use the convention taint `sku=gpu:NoSchedule`. A GPU pod must carry the matching toleration (`key=sku, value=gpu, effect=NoSchedule`), request `nvidia.com/gpu: 1`, and (by convention) select `accelerator: nvidia`. A missing toleration is the most common Pending cause after quota.
4. **No `nvidia.com/gpu` advertised on the node** → a driver / device-plugin model mismatch. See the driver decision matrix in [references/gpu-scheduling.md](references/gpu-scheduling.md).

## Symptom → reference

| Symptom | Reference |
|---------|-----------|
| Pod Pending "Insufficient nvidia.com/gpu"; taints/quota/scheduling; driver models; `--gpu-driver` | [references/gpu-scheduling.md](references/gpu-scheduling.md) |
| KAITO Workspace never becomes ready; conditions; the delete-doesn't-delete-the-pool cost trap | [references/kaito-workspaces.md](references/kaito-workspaces.md) |
| Idle GPU cost, scale-to-zero, spot eviction, SKU-to-model right-sizing, KEDA on GPU | [references/gpu-cost-and-scaling.md](references/gpu-cost-and-scaling.md) |
| GPU utilization/VRAM metrics, DCGM, OOMKilled on weight load | [references/gpu-observability.md](references/gpu-observability.md) |

## Fast triage

```bash
# Are GPUs schedulable? (capacity/allocatable nvidia.com/gpu + the accelerator label)
kubectl describe node <gpu-node> | grep -EA6 "Labels:|Capacity:|Allocatable:"
kubectl get nodes -o custom-columns=NAME:.metadata.name,GPU:.status.allocatable.'nvidia\.com/gpu'

# Why is a GPU pod Pending?
kubectl describe pod <pod> | grep -A15 Events

# Is the driver/device-plugin stack present?
kubectl get pods -A -o wide | grep -Ei "nvidia|device-plugin|dcgm"
az aks nodepool show -g <rg> --cluster-name <cluster> -n <pool> --query gpuProfile

# GPU vCPU quota by family (the exact "Insufficient vCPU quota" check)
az vm list-usage --location "<region>" -o table | grep -Ei "Total Regional|NC|ND"
```

## Two facts that break copy-pasted commands

- **DCGM metrics port differs by install model.** AKS-**managed** GPU pools expose the DCGM exporter on **port 19400**; NVIDIA upstream / GPU-Operator use **9400**. A `curl localhost:9400/metrics` against a managed pool returns nothing.
- **Kubernetes has no GPU-memory-pressure signal.** VRAM exhaustion surfaces only as a container **OOMKilled (exit 137)** — *after* DCGM (`DCGM_FI_DEV_FB_USED`/`FB_FREE`) already shows the trend. Size the SKU to the model up front.

## Reference

- Use NVIDIA GPUs on AKS: https://learn.microsoft.com/azure/aks/use-nvidia-gpu
- AI toolchain operator (KAITO): https://learn.microsoft.com/azure/aks/ai-toolchain-operator
- GPU observability best practices: https://learn.microsoft.com/azure/aks/best-practices-gpu-observability
