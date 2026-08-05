---
name: aks-cost-optimization
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
description: "Reduce Azure Kubernetes Service (AKS) spending: pod rightsizing, VPA-driven recommendations, cluster-autoscaler tuning, spot node pools, namespace-level cost visibility, and cost-anomaly detection. WHEN: rightsize pods, VPA recommendations, idle nodes, scale-down, autoscaler profile, spot nodes, cheaper compute, cost add-on, namespace cost breakdown, spending anomaly, 'my AKS bill is too high', 'is my app consuming what it requests', resource requests vs actual usage, over-provisioned workloads, spot vs on-demand, per-namespace or per-team cost allocation, 'who's spending what and why'. DO NOT USE FOR: GPU / inference cost and idle GPU pools (use aks-gpu-inference); autoscaler that is failing to scale up during an incident (use aks-troubleshooting); choosing SKUs at cluster-creation time (use aks-cluster-setup)."
---

# AKS Cost Optimization — Router

Route by goal to the correct reference file:

| Goal | File |
|------|------|
| Identify over-provisioned pods, reduce CPU/memory requests | [azure-aks-rightsizing.md](./azure-aks-rightsizing.md) |
| Enable VPA for data-driven resource recommendations | [azure-aks-vpa.md](./azure-aks-vpa.md) |
| Tune cluster autoscaler to scale down idle nodes | [azure-aks-autoscaler.md](./azure-aks-autoscaler.md) |
| Add spot node pools for batch/interruptible workloads | [azure-aks-spot.md](./azure-aks-spot.md) |
| Enable namespace-level cost visibility add-on | [azure-aks-cost-addon.md](./azure-aks-cost-addon.md) |
| Detect cost anomalies and spending spikes | [azure-aks-anomalies.md](./azure-aks-anomalies.md) |
