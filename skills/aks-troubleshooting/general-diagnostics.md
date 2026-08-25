# General AKS Investigation & Diagnostics

## "What happened in my cluster?"

When a user asks a broad question like "what happened in my AKS cluster?" or "check my AKS status", follow this systematic flow:

1. Cluster health
2. Recent events
3. Node status
4. Unhealthy pods
5. All pods overview
6. System pods health
7. Activity log

Run the target-bound baseline instead of issuing an ambient-context command
chain. It stops before Kubernetes collection unless the named context endpoint
matches the named AKS resource, stores raw output outside model context, and
prints one redacted projection.

```bash
scripts/aks-baseline.sh \
  --subscription <subscription-id> \
  --resource-group <resource-group> \
  --cluster <cluster-name> \
  --context <kube-context> \
  --artifacts-dir <new-empty-directory>
```

```powershell
scripts/aks-baseline.ps1 `
  -Subscription <subscription-id> `
  -ResourceGroup <resource-group> `
  -Cluster <cluster-name> `
  -Context <kube-context> `
  -ArtifactsDir <new-empty-directory>
```

---

## AKS CLI Tools

```bash
# Get cluster credentials (required before kubectl commands)
az aks get-credentials -g <rg> -n <cluster>

# View node pools
az aks nodepool list -g <rg> --cluster-name <cluster> -o table
```

### Discovered Azure diagnostic capability

Ask the host to enumerate connected diagnostic capabilities and their schemas.
If it exposes an AKS-compatible AppLens or detector read, select the smallest
schema that accepts the exact cluster resource ID and a bounded incident window.
Do not assume a host-rendered tool name. If no matching capability is available,
continue with the explicit `az` and `kubectl` fallback.

```text
capability: discovered AppLens/detector read
intent: diagnose AKS cluster issues
required schema input:
  resourceId: /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ContainerService/managedClusters/<cluster>
  incidentWindow: <explicit UTC interval>
```

Treat detector output as evidence, not an automatic root-cause verdict. Preserve
the detector name, time window, finding severity, and supporting observation.

---

## Best Practices

1. **Start with kubectl get/describe** - Always check basic status first
2. **Check events** - `kubectl get events -A` reveals recent issues
3. **Use systematic isolation** - Pod -> Node -> Cluster -> Network
4. **Document changes** - Note what you tried and what worked
5. **Escalate when needed** - For control plane issues, contact Azure support
