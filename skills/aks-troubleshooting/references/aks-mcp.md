# AKS MCP Reference

Use this reference to discover and select AKS-aware Azure MCP tools in the current host.

## Capability Discovery

1. Inspect the host's available tool catalog or tool descriptions.
2. Find Azure MCP capabilities that advertise AKS operations. Also identify supporting AppLens, Azure Monitor, and Resource Health capabilities when the investigation needs them.
3. Use the matching capabilities under the names assigned by the host. Names and prefixes are host-specific; a literal name is never an availability check.
4. Inspect the selected tool's advertised schema or built-in discovery surface, then choose the smallest read operation that fits.

Do not guess names, translate one host's name to another, or build a mapping layer. Capability metadata supplied by the host is the source of truth.

## Preference Order

1. Host-discovered Azure MCP AKS capability
2. Supporting host-discovered AppLens, Azure Monitor, or Resource Health capabilities
3. Raw `az aks` and `kubectl` only when required functionality is missing from the discovered MCP surface

## Happy Path

After selecting the Azure MCP AKS capability, inspect the exact operations and parameter schemas it exposes. If it provides its own discovery operation, use that before the task-specific call.

Favor the obvious read paths first:

- cluster and Azure-side inspection
- detector or diagnostic workflows
- monitoring, metrics, or control-plane-log checks
- kubectl-style read operations

## Authentication And Access

Authentication is host-specific. In Azure SRE Agent, built-in Azure operations use the agent's user-assigned managed identity; verify its target scope and RBAC. An external MCP connector uses the authentication configured on that connector. In CLI-backed hosts, the Azure MCP server can use the host's Azure CLI or service-principal context. Inspect the host and tool schema rather than assuming one credential source.

Default to `readonly`. Only suggest `readwrite` or `admin` when the current diagnostic step truly requires it.

## Detector Notes

For detector-style workflows, use the cluster resource ID, keep the time window within the last 30 days, cap each run to 24 hours, and stay within the supported AKS detector categories.

## Fallback Rule

If capability discovery finds no Azure MCP AKS tool, or the discovered surface does not provide the operation needed for a check, fall back to:

- `az aks` for Azure-side AKS operations
- raw `kubectl` for Kubernetes-side inspection
