# AKS Cluster Autoscaler (CAS)

Enable and tune the Cluster Autoscaler to automatically scale down idle nodes.

## Check CAS Status

```bash
az aks show \
  --name "<CLUSTER_NAME>" --resource-group "<RESOURCE_GROUP>" \
  --query "agentPoolProfiles[].{name:name, casEnabled:enableAutoScaling, min:minCount, max:maxCount, count:count}" \
  -o table

az aks show \
  --name "<CLUSTER_NAME>" --resource-group "<RESOURCE_GROUP>" \
  --query "autoScalerProfile" -o json
```

## Check Node Utilization (7 days)

Follow the metrics discovery steps in [azure-aks-rightsizing.md](./azure-aks-rightsizing.md#historical-metrics-azure-monitor--use-when-prometheus-or-container-insights-is-enabled) to list available metric definitions and query node CPU utilization. Use metric names such as `node_cpu_usage_percentage` or `cpuUsagePercentage` depending on what's available on the cluster.

## Enable CAS

```bash
# Cluster-level
az aks update \
  --name "<CLUSTER_NAME>" --resource-group "<RESOURCE_GROUP>" \
  --enable-cluster-autoscaler \
  --min-count <MIN_NODES> --max-count <MAX_NODES>

# Specific node pool
az aks nodepool update \
  --cluster-name "<CLUSTER_NAME>" --resource-group "<RESOURCE_GROUP>" \
  --name "<NODEPOOL_NAME>" \
  --enable-cluster-autoscaler \
  --min-count <MIN_NODES> --max-count <MAX_NODES>
```

## Recommended min/max Defaults

| Scenario | min-count | max-count |
|----------|-----------|-----------|
| Dev/test | 1 | current_count |
| Production (web/API) | 2 | current_count * 3 |
| Production (batch) | 0 | current_count * 5 |

> Risk: Low. CAS only scales down when pods can be safely rescheduled. Set min-count >= 2 for production HA.

## Tune CAS Profile

Apply when CAS is already on but idle nodes persist. This uses the "Cost-Optimized" profile from the table below — the delay and unneeded-time timers are halved from the 10-minute defaults, and the utilization threshold is left at its 0.5 default (see [Microsoft Learn: cluster autoscaler profile settings](https://learn.microsoft.com/azure/aks/cluster-autoscaler#cluster-autoscaler-profile-settings) for the documented parameter names and defaults):

```bash
az aks update \
  --name "<CLUSTER_NAME>" --resource-group "<RESOURCE_GROUP>" \
  --cluster-autoscaler-profile \
    scale-down-delay-after-add=5m \
    scale-down-unneeded-time=5m \
    scale-down-utilization-threshold=0.5 \
    max-graceful-termination-sec=600
```

> Risk: Medium. Shortening `scale-down-delay-after-add` and `scale-down-unneeded-time` makes CAS reclaim idle nodes faster, which increases savings but also increases the chance CAS deletes a node and then has to immediately reprovision one for the next burst ("thrashing"), adding node-provisioning latency to your workloads. Microsoft's own guidance on aggressive autoscaler tuning applies here: this isn't recommended for clusters with frequent scale-out/scale-in cycles in short intervals — raise `scale-down-delay-after-add` back toward the 10m default if you see repeated reprovisioning. ([Microsoft Learn: configure cluster autoscaler profile for aggressive scale-down](https://learn.microsoft.com/azure/aks/cluster-autoscaler#configure-cluster-autoscaler-profile-for-aggressive-scale-down))

> ⚠️ **Do not add `skip-nodes-with-system-pods=false` as a cost lever.** This setting defaults to `true`, so CAS won't delete a node that hosts non-DaemonSet `kube-system` pods ([Microsoft Learn: cluster autoscaler profile settings](https://learn.microsoft.com/azure/aks/cluster-autoscaler#cluster-autoscaler-profile-settings)). Microsoft manages add-ons and other system components in `kube-system`, and customers can't alter those managed components ([Microsoft Learn: AKS support policies](https://learn.microsoft.com/azure/aks/support-policies#managed-features-in-aks)). Don't assume every managed add-on can be protected by a customer-managed PodDisruptionBudget; leave the setting at its default.

To roll back to CAS defaults:

```bash
az aks update \
  --name "<CLUSTER_NAME>" --resource-group "<RESOURCE_GROUP>" \
  --cluster-autoscaler-profile ""
```

## Profile Comparison

| Profile | scale-down-delay-after-add | scale-down-unneeded-time | utilization-threshold | Best For |
|---------|----------------------------|--------------------------|----------------------|----------|
| Default | 10m | 10m | 0.5 | General workloads |
| Cost-Optimized | 5m | 5m | 0.5 | Cost-sensitive, non-critical |
| Conservative | 30m | 30m | 0.7 | Stateful / production |
| Aggressive | 2m | 2m | 0.4 | Dev/test, batch |

> Risk: High for aggressive tuning. Ensure PodDisruptionBudgets (PDBs) are set on critical user workloads before tuning. Always confirm with user before applying.
>
> Check existing PDBs before tuning:
> ```bash
> kubectl get pdb --all-namespaces
> ```
