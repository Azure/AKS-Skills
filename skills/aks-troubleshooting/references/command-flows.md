# AKS Command Flows

## Cluster Baseline Flow

```text
Resolve subscription -> resolve resource group -> resolve cluster -> inspect cluster state -> inspect node pools -> inspect resource health -> inspect recent operations
```

Portable Azure CLI fallback for cluster metadata, activity, and operations:

```bash
az aks show -g <resource-group> -n <cluster-name>
az aks nodepool list -g <resource-group> --cluster-name <cluster-name>
az monitor activity-log list -g <resource-group> --max-events 20
```

## Kubernetes Baseline Flow

```text
Check API reachability -> inspect nodes -> inspect kube-system -> inspect events -> inspect affected namespace -> inspect pod details and logs
```

Portable Kubernetes CLI flow:

```bash
kubectl cluster-info
kubectl get nodes -o wide
kubectl get pods -n kube-system
kubectl get events -A --sort-by=.lastTimestamp
kubectl get pods -n <namespace>
kubectl describe pod <pod-name> -n <namespace>
kubectl logs <pod-name> -n <namespace> --previous
```

## Connectivity Flow

```text
pod -> service -> endpoints -> ingress or load balancer -> DNS -> network controls
```

Portable Kubernetes CLI flow:

```bash
kubectl get pods -n <namespace> -o wide
kubectl get svc -n <namespace>
kubectl get endpoints -n <namespace>
kubectl get ingress -n <namespace>
kubectl describe ingress <ingress-name> -n <namespace>
```

## Detector Flow

Use the separately advertised Azure MCP AppLens area when available; this is not part of the Azure MCP AKS metadata area.

```text
resolve cluster resource ID -> list detectors or choose category -> select a focused time window -> run the detector or category -> rank critical findings above warnings -> ignore emerging issues when choosing the primary root cause
```

## Monitoring Flow

Use separately advertised Azure MCP Monitor and Resource Health areas when available, or their Azure CLI equivalents.

```text
check resource health -> inspect metrics -> verify diagnostics settings -> inspect control plane logs if available -> correlate with Application Insights or namespace symptoms
```

## Scheduling Flow

```text
pod events -> node capacity -> taints and tolerations -> affinity rules -> PVC state -> quotas
```

Portable Kubernetes CLI flow:

```bash
kubectl describe pod <pod-name> -n <namespace>
kubectl get nodes -o wide
kubectl describe node <node-name>
kubectl get pvc -n <namespace>
kubectl describe quota -n <namespace>
```

## Deep Diagnostics Flow (Inspektor Gadget)

```text
Standard diagnostics inconclusive -> resolve target node -> select gadget from symptom-to-gadget map -> run IG command with namespace/pod filters -> interpret output -> correlate with prior evidence
```

Use when steps 1–3 of the evidence order (Azure-side, Kubernetes-side, and detector evidence) do not reveal root cause. See [inspektor-gadget.md](inspektor-gadget.md) for the full gadget catalog and command patterns.

## Safety Boundary

Treat the following as change operations and avoid them unless the user explicitly asks for remediation:

- deleting or restarting pods
- cordon and drain operations
- scaling workloads or node pools
- cluster upgrade operations
- DNS, route, NSG, or firewall changes
