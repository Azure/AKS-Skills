# AKS Troubleshooting Provenance and Package Boundary

## Reconciliation point

This focused bundle reconciles two immutable public source points:

- `microsoft/GitHub-Copilot-for-Azure`
  `22f96fd93fa85814b7a8ffdfe5356a5bab96a096`
- `Azure/AKS-Skills` PR #72 base
  `a1cab4852d3e6cdb20e06b171400117379cbd90c`

GHCP originated the shared AKS troubleshooting tree. AKS-Skills imported the
published content in commit
`856eb9b5eb508387e996810ac7ad405abb0fece7`, then both repositories evolved.
At the accepted evidence comparison, 12 relative paths were shared: five were
byte-identical and seven had diverged. Before this layer, the #72 base had
already strengthened `network-policy.md` and `upgrade-operations.md`; this layer
preserves all five current base files unchanged and records both blob states in
the source manifest.

Historically byte-identical shared files preserved from the #72 base:

- `load-balancer-and-ingress.md`
- `network-policy.md`
- `references/structured-input-modes.md`
- `spot-and-zone-issues.md`
- `upgrade-operations.md`

Reconciled shared files:

- `general-diagnostics.md`
- `networking.md`
- `node-issues.md`
- `pod-failures.md`
- `references/aks-mcp.md`
- `references/command-flows.md`
- `references/inspektor-gadget.md`

AKS-Skills-only assets preserved here:

- `references/report-template.md`
- `references/symptom-map.md`
- `scripts/cluster-snapshot.sh`
- `scripts/pod-deep-dive.sh`

## Current state

GHCP does not currently consume this bundle. Its broad `azure-diagnostics`
package and this focused package are independently authored today. No reviewed
trace proves that Azure Portal consumes either repository's exact payload. The
Agent Skills format has description-driven discovery but no portable
cross-plugin dependency, presence, or priority field.

## Intended boundary

- Broad Azure package only: `azure-diagnostics` remains the broad entry point
  and retains its current AKS coverage.
- Focused AKS package only: `aks-troubleshooting` is the entry point for deep AKS
  incidents.
- Focused package absent: a future GHCP materialized payload must be available
  at build time; installed packages must not fetch this repository at runtime.
- Both installed: `aks-troubleshooting` is intended for AKS incidents and
  `azure-diagnostics` for non-AKS or cross-service Azure incidents, but this is
  not a support claim until that host passes paired routing tests. A host that
  cannot prove the route should ship one package.

If owners accept the upstream contract, GHCP materializes an exact source commit
and canonical tree hash at build time, with no manual edits to generated
payload. If owners reject that mechanical contract, the fallback is
consolidation into GHCP rather than a permanent hand-maintained fork.

Runtime model, identity, authorization, tools, transport, retention, tracing,
and UX remain host-owned.
