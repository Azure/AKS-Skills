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

```bash
az aks show -g <rg> -n <cluster> --query "provisioningState"
kubectl get events -A --sort-by='.lastTimestamp' | head -40
kubectl get nodes -o wide
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
kubectl get pods -A -o wide
kubectl get pods -n kube-system -o wide
az monitor activity-log list -g <rg> --max-events 20 -o table
```

---

## AKS CLI Tools

```bash
# Get cluster credentials (required before kubectl commands)
az aks get-credentials -g <rg> -n <cluster>

# View node pools
az aks nodepool list -g <rg> --cluster-name <cluster> -o table
```

### Azure MCP AppLens area for AKS

AppLens is a separate Azure MCP Server area, not part of its AKS cluster/node-pool metadata area. For AI-powered diagnostics:

```text
<host-assigned Azure MCP AppLens tool>
  resource: "<cluster-name>"
  question: "Diagnose the reported AKS cluster issue and recommend remediation."
  resource-group: "<resource-group>"  # optional disambiguation
  resource-type: "Microsoft.ContainerService/managedClusters"  # optional disambiguation
```

The angle-bracketed token is a placeholder, not a literal tool name. Inspect the host's available tools for the Azure MCP capability that advertises AppLens diagnostics, use its assigned name, and follow its advertised schema. The representative inputs above match the current AppLens capability; omit or rename them if the host advertises a different schema.

> 💡 **Tip:** AppLens uses the resource name and diagnostic question; provide the resource group and type only when needed to disambiguate the cluster.

---

## Best Practices

1. **Start with kubectl get/describe** - Always check basic status first
2. **Check events** - `kubectl get events -A` reveals recent issues
3. **Use systematic isolation** - Pod -> Node -> Cluster -> Network
4. **Document changes** - Note what you tried and what worked
5. **Escalate when needed** - For control plane issues, contact Azure support
