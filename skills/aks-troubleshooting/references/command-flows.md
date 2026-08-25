# AKS Command Flows

## Contents

- [Cluster Baseline Flow](#cluster-baseline-flow)
- [Kubernetes Baseline Flow](#kubernetes-baseline-flow)
- [Connectivity Flow](#connectivity-flow)
- [Deep Diagnostics Flow](#deep-diagnostics-flow-inspektor-gadget)
- [Safety Boundary](#safety-boundary)

## Cluster Baseline Flow

```text
Resolve subscription -> resolve resource group -> resolve cluster -> inspect cluster state -> inspect node pools -> inspect resource health -> inspect recent operations
```

Portable fallback when no discovered capability can perform the cluster
baseline read:

```bash
scripts/aks-baseline.sh \
  --subscription <subscription-id> \
  --resource-group <resource-group> \
  --cluster <cluster-name> \
  --context <kube-context> \
  --artifacts-dir <new-empty-directory>
```

## Kubernetes Baseline Flow

```text
Check API reachability -> inspect nodes -> inspect kube-system -> inspect events -> inspect affected namespace -> inspect pod details and logs
```

The same target-bound baseline proves the kube endpoint before these reads. For
pod detail and logs, use `scripts/pod-evidence.sh` or
`scripts/pod-evidence.ps1`; do not stream raw logs into model context.

```bash
scripts/pod-evidence.sh \
  --subscription <subscription-id> \
  --resource-group <resource-group> \
  --cluster <cluster-name> \
  --context <kube-context> \
  --artifacts-dir <new-empty-directory> \
  --pod <pod-name> --namespace <namespace>
```

## Connectivity Flow

```text
pod -> service -> endpoints -> ingress or load balancer -> DNS -> network controls
```

CLI fallback when no discovered capability can perform the connectivity read:

```bash
kubectl get pods -n <namespace> -o wide
kubectl get svc -n <namespace>
kubectl get endpoints -n <namespace>
kubectl get ingress -n <namespace>
kubectl describe ingress <ingress-name> -n <namespace>
```

## Detector Flow

```text
resolve cluster resource ID -> list detectors or choose category -> select a focused time window -> run the detector or category -> rank critical findings above warnings -> ignore emerging issues when choosing the primary root cause
```

## Monitoring Flow

```text
check resource health -> inspect metrics -> verify diagnostics settings -> inspect control plane logs if available -> correlate with Application Insights or namespace symptoms
```

## Scheduling Flow

```text
pod events -> node capacity -> taints and tolerations -> affinity rules -> PVC state -> quotas
```

CLI fallback when no discovered capability can perform the scheduling read:

```bash
kubectl describe pod <pod-name> -n <namespace>
kubectl get nodes -o wide
kubectl describe node <node-name>
kubectl get pvc -n <namespace>
kubectl describe quota -n <namespace>
```

## Deep Diagnostics Flow (Inspektor Gadget)

```text
Standard diagnostics inconclusive -> prove target -> select an allowed gadget -> preview run-ig -> obtain privileged approval and deadline -> execute -> confirm exact debug-pod cleanup -> correlate the safe projection with prior evidence
```

Use when steps 1–3 of the evidence order (Azure-side, Kubernetes-side, and
detector evidence) do not reveal root cause. See
[inspektor-gadget.md](inspektor-gadget.md) for the validated script contract and
gadget catalog.

## Safety Boundary

Treat the following as change operations and avoid them unless the user explicitly asks for remediation:

- deleting or restarting pods
- cordon and drain operations
- scaling workloads or node pools
- cluster upgrade operations
- DNS, route, NSG, or firewall changes
