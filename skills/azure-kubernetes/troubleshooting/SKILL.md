---
name: azure-kubernetes-troubleshooting
description: "Debug live AKS cluster issues: pod crashes, node failures, networking/DNS, ingress/load-balancer errors, network policy, upgrade failures, spot/zone disruptions. WHEN: CrashLoopBackOff, OOMKilled, ImagePullBackOff, node NotReady, DNS failure, 502/503, connectivity timeout, upgrade stuck, eviction, spot interrupted, network policy denied."
---

# AKS Troubleshooting — Router

Route by symptom to the correct reference file:

| Symptom | File |
|---------|------|
| Broad cluster investigation, unknown root cause | [general-diagnostics.md](./general-diagnostics.md) |
| Pod crash, OOM, ImagePull, Pending, readiness probe | [pod-failures.md](./pod-failures.md) |
| Node NotReady, node pressure, node scaling | [node-issues.md](./node-issues.md) |
| Service connectivity, DNS, pod-to-pod networking | [networking.md](./networking.md) |
| Ingress 502/503, load balancer health probe, external access | [load-balancer-and-ingress.md](./load-balancer-and-ingress.md) |
| Network policy blocking traffic | [network-policy.md](./network-policy.md) |
| Upgrade stuck, cordon/drain failures | [upgrade-operations.md](./upgrade-operations.md) |
| Spot eviction, zone rebalance failures | [spot-and-zone-issues.md](./spot-and-zone-issues.md) |
