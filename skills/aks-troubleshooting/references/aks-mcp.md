# Discovered Azure Capability Reference

Use this reference when the host exposes connected Azure or AKS diagnostic
capabilities.

## Preference Order

1. Ask the host to enumerate available capabilities and their input schemas.
2. Select the smallest read capability whose schema matches the exact AKS task.
3. Use supporting detector, monitor, or resource-health reads only when their
   discovered schemas accept the target resource and incident window.
4. Fall back explicitly to `az` for Azure-side AKS reads and `kubectl` for
   Kubernetes-side reads when no discovered capability fits.

## Happy Path

Do not write or guess a rendered wrapper name. Tool names are host-owned and can
change across Copilot, Claude, managed agents, and other Agent Skills clients.
Discovery and schema matching are the portable contract.

Favor the obvious read paths first:

- cluster and Azure-side inspection
- detector or diagnostic workflows
- monitoring, metrics, or control-plane-log checks
- kubectl-style read operations

## Authentication and Access

Identity, authorization, transport, retention, and UX are host-owned. A skill
does not grant access. Require the host to surface the selected identity and
target subscription, and default to the least-privileged read mode.

Do not silently change subscriptions or kube contexts. The focused evidence
scripts require both explicitly and prove that the named kube endpoint belongs
to the named AKS resource.

## Detector Notes

For detector-style workflows, use the cluster resource ID, keep the time window within the last 30 days, cap each run to 24 hours, and stay within the supported AKS detector categories.

## Fallback Rule

If discovery does not expose a matching read capability, fall back to:

- `az aks` for Azure-side AKS operations
- raw `kubectl` for Kubernetes-side inspection
