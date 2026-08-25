# AKS Skills vs. Azure Skills

AKS Skills is a focused AKS domain package. Azure Skills is the broad Azure
plugin distributed from
[GitHub Copilot for Azure](https://github.com/microsoft/GitHub-Copilot-for-Azure)
(GHCP). They overlap today; they are not yet a functioning upstream/downstream
pair.

## Current facts

- GHCP originated the shared AKS troubleshooting tree.
- AKS-Skills imported that published tree in commit
  `856eb9b5eb508387e996810ac7ad405abb0fece7`; both repositories then evolved.
- This reconciliation uses GHCP
  `22f96fd93fa85814b7a8ffdfe5356a5bab96a096` and AKS-Skills PR #72 base
  `a1cab4852d3e6cdb20e06b171400117379cbd90c`.
- At the accepted evidence comparison, 12 relative troubleshooting paths were
  shared: five were byte-identical and seven diverged. The #72 base subsequently
  strengthened two of those five; this layer preserves all five current base
  files and records both blob states. GHCP also added strong dual-shell evidence
  scripts; AKS-Skills added focused taxonomy, safety/evidence contracts, a
  symptom map, and a report template.
- GHCP has broad Azure distribution and cross-service diagnostics. AKS-Skills
  provides focused AKS depth and service-owned source.
- GHCP does **not** currently consume AKS-Skills. No reviewed trace proves that
  Azure Portal consumes either repository's exact payload.
- The Agent Skills standard has description-driven discovery but no portable
  plugin dependency, presence, or priority field.

## Which package to use now

| Installed state | Truthful current behavior |
| --- | --- |
| Broad Azure package only | Use `azure-diagnostics`; it retains GHCP's current AKS and cross-service coverage. |
| Focused AKS package only | Use `aks-troubleshooting` for deep AKS incidents and the other focused skills for cost, readiness, GPU, packet capture, known issues, and cluster design. |
| Focused package absent | The broad package remains self-sufficient today. There is no runtime fetch from AKS-Skills. |
| Both installed | Intended boundary: `aks-troubleshooting` for AKS incidents, `azure-diagnostics` for non-AKS or cross-service Azure incidents. This is **not** a deterministic support claim until that host passes paired routing tests. If the host cannot prove the route, ship one package rather than a coin flip. |

Runtime model, identity, authorization, tools, transport, retention, tracing,
and UX remain host-owned. Static Markdown does not grant access or enforce a
cross-plugin route.

## Target source and distribution contract

If the owners agree:

1. `Azure/AKS-Skills/skills/aks-troubleshooting/**` is the one editable source
   for deep AKS domain knowledge, evidence rules, scripts, normalized output,
   safety, and benchmark-facing metadata.
2. GHCP materializes that payload at build time from an exact source commit and
   canonical tree hash.
3. Generated downstream payload is not manually edited or committed as a
   second source, and installed packages never fetch AKS-Skills at runtime.
4. Every pin bump is a reviewable GHCP change.
5. Broad-only, focused-only, focused-absent, and both-installed behavior is
   tested before a host is advertised for that state.

If GHCP owners reject that mechanical contract, the fallback is consolidation
into GHCP. A permanent manually maintained two-repository fork is not an
acceptable target.

The source contract is
[`skills/aks-troubleshooting/bundle.source.json`](../skills/aks-troubleshooting/bundle.source.json).
The dependency-free exporter emits a strict bundle manifest plus source lock.
PR #95's benchmark core remains unchanged; later adapter/result work can consume
those artifacts without making this source PR a runtime or a result claim.

## Responsibility boundary

| Area | Broad Azure package | Focused AKS package |
| --- | --- | --- |
| Provisioning and deployment | `azure-prepare` / `azure-validate` / `azure-deploy`; Azure-wide lifecycle | `aks-cluster-setup` makes AKS design decisions and can delegate generic execution |
| Troubleshooting | `azure-diagnostics`: broad Azure and cross-service triage, with substantial AKS coverage and read-only evidence scripts | `aks-troubleshooting`: deep AKS incident taxonomy, target-bound evidence, node/network/workload forensics |
| Cost | Cross-resource Azure cost guidance | AKS autoscaler, spot, rightsizing, and workload-specific cost |
| AI/GPU | Setup and broad Azure AI flows | Day-2 GPU, KAITO, scheduling, scaling, and inference operations |
| Packet evidence | No focused AKS packet skill | `aks-network-capture` |

## Standalone and delegated behavior

`aks-cluster-setup` remains a thin AKS design facade. When broad Azure Skills is
available, it can delegate generic provisioning execution. When it is absent,
the focused skill still produces the AKS design and explicit CLI/IaC handoff;
it does not dead-end.

The troubleshooting bundle is independently useful. Its collectors require
explicit Azure and kube targets, prove that both identify the same AKS cluster,
and keep raw evidence outside model context.

## Coordinating changes

`microsoft/azure-skills` is a read-only mirror synchronized from GHCP. Do not
open PRs against the mirror. Coordinate GHCP boundary, lock, materializer,
routing, and pin-bump changes issue-first in
`microsoft/GitHub-Copilot-for-Azure`.
