---
name: azure-kubernetes
license: MIT
metadata:
  author: Microsoft
  version: "0.0.2"
description: "Plan, create, and configure production-ready Azure Kubernetes Service (AKS) clusters. Covers Day-0 checklist, SKU selection (Automatic vs Standard), networking options (private API server, Azure CNI Overlay, egress configuration), security, and operations (autoscaling, upgrade strategy, cost analysis). WHEN: create AKS environment, provision AKS environment, enable AKS observability, design AKS networking, choose AKS SKU, secure AKS, optimize AKS, rightsize AKS pod, AKS spot nodes, AKS cluster-autoscaler."
---

# Azure Kubernetes Service — Skill Router

This is the entry point for all AKS-related tasks. **Do not implement guidance here.** Identify the user's intent from the routing table below, load the matching subskill, and follow its instructions.

## Routing Table

| Subskill | Path | Use When | Trigger Keywords |
|----------|------|----------|-----------------|
| **Best Practices** | [best-practices/SKILL.md](./best-practices/SKILL.md) | User wants to create, plan, or configure an AKS cluster; make Day-0 decisions (networking, API server, SKU); set up security, observability, upgrades, node pools, reliability, or cost controls | create cluster, plan cluster, Day-0, networking, CNI, overlay, egress, ingress, SKU, Automatic vs Standard, security, Entra, observability, Prometheus, Grafana, upgrades, maintenance window, node pools, autoscaler, spot nodes, VPA, rightsizing, reliability, PDB, KEDA |
| **Automatic Readiness** | [automatic-readiness/SKILL.md](./automatic-readiness/SKILL.md) | User wants to migrate an existing cluster to AKS Automatic, check compatibility, or fix manifests/deployments for Automatic constraints | migrate to Automatic, readiness check, Automatic compatibility, NAP constraints, migration blockers, is my cluster ready for Automatic |
| **Troubleshooting** | [troubleshooting/SKILL.md](./troubleshooting/SKILL.md) | User is debugging a live AKS issue — pods, nodes, networking, ingress, upgrades, or evictions | pod crash, CrashLoopBackOff, node not ready, DNS failure, connectivity, timeout, 502, 503, upgrade stuck, OOM, eviction, load balancer, ingress error, network policy denied, spot interrupted |
| **Cost Optimization** | [cost-optimization/SKILL.md](./cost-optimization/SKILL.md) | User wants to reduce AKS spending — rightsizing, autoscaler tuning, spot pools, VPA, cost visibility | rightsize pods, VPA, idle nodes, autoscaler, scale-down, spot nodes, cheaper compute, cost add-on, namespace cost, spending anomaly |

## Routing Rules

1. Match intent to the **most specific** subskill and load that file.
2. If multiple subskills apply, load them in priority order (most specific first).
3. If no subskill matches, ask the user to clarify their AKS-related goal.

## Shared References

Available to all subskills:
- [cli-reference.md](./references/cli-reference.md) — AKS CLI commands
