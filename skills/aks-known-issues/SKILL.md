---
name: aks-known-issues
license: MIT
metadata:
  author: Microsoft
  version: "0.1.0"
  openclaw:
    emoji: "🔖"
    requires:
      anyBins:
        - az
        - kubectl
description: "Match an AKS operation failure against a curated, versioned table of documented known issues and error codes — each entry carrying the cause and the Microsoft-documented fix, workaround, or platform limitation. Deterministic error-string → diagnosis lookup for specific, named failures: VM-extension / CSE provisioning errors (VMExtensionProvisioningError, OrasPullUnauthorizedVMExtensionError / exit 212), VMCannotFitEphemeralOSDisk, LinkedAuthorizationFailed, NodePoolMcVersionIncompatible, node-image / snapshot 'NodeImageVersion is not accepted', and network-isolated-cluster ACR pull failures. WHEN: an AKS create / scale / upgrade / image-pull fails with a NAMED error code or message; 'what does <error> mean on AKS?'; 'is <error> a known issue?'; 'CSE / VM extension exit code'; 'VMCannotFitEphemeralOSDisk'; 'LinkedAuthorizationFailed'; 'NodeImageVersion is not accepted'. DO NOT USE FOR: open-ended incident investigation with no specific error code — pod crashes, NotReady, DNS, ingress, timeouts (use aks-troubleshooting); SKU / capacity allocation decode such as SkuNotAvailable or OverconstrainedAllocationRequest (use aks-troubleshooting). Read-only: it explains and cites the documented fix, and never applies changes without explicit approval."
---

# AKS Known Issues

Turn a specific AKS **error code or message** into a documented diagnosis: the cause, the Microsoft-documented fix or workaround, and the reference that proves it. This skill is a deterministic string→diagnosis matcher, not an open-ended investigation — it fires when the failure already names itself (an error code, an extension exit code, a rejected value) and you want the known answer fast.

## Operating rules

**Read-only by default.** Do not upgrade, reimage, delete, reconcile, scale, or modify role assignments on the cluster or its Azure resources unless the user explicitly asks. Match the error, explain the cause, cite the documented fix — then apply it only on explicit approval.

**Match on the signature, not the vibe.** Only claim a known issue when the actual error string matches the entry (code, message, and the operation that produced it). If the symptom is generic and no specific error code is present, this is not the right skill — route to `aks-troubleshooting`.

**Cite the source.** Every match names its Microsoft Learn reference so the user (or a support engineer) can verify the fix before acting. If you cannot cite a documented source, say so and hand off — do not invent a "known issue."

## How to use

1. **Capture the exact failure** — the error code, the full message, and the operation (`az aks nodepool show` on a `provisioningState=Failed` pool surfaces the code; VM-extension failures surface `vmssCSE` exit codes; ARM/CLI returns the error verbatim).
2. **Match** it against the table below (common set) or [references/error-code-map.md](references/error-code-map.md) (full catalog).
3. **Confirm the signature** matches — same code, same operation class.
4. **Present** the cause + the documented fix + the reference URL. Flag whether the fix is read-only (a config check) or a change that needs approval.
5. **Route out** if there is no match: generic incidents → `aks-troubleshooting`; SKU/capacity allocation failures → `aks-troubleshooting` (until a dedicated capacity-triage skill exists).

## Common known issues

| Error / signature | What it means | Documented fix |
|---|---|---|
| Node pool `provisioningState=Failed` | The backing VMSS hit an error during provision/scale/update — capacity, quota, network, policy, or a resource lock | Read the exact code from `az aks nodepool show`, then `az vmss show`; resolve the underlying cause (quota/capacity/policy/lock) and reconcile with `az aks nodepool update` |
| `VMCannotFitEphemeralOSDisk` | The requested OS disk doesn't fit the VM SKU's cache/temp storage, but ephemeral was requested (or defaulted) | Use a VM SKU with a large enough cache/temp, reduce `--node-osdisk-size`, or set `--node-osdisk-type Managed`. OS disk type/size can't change in place — create a new node pool and migrate |
| `LinkedAuthorizationFailed` | The cluster identity (managed identity or SP) lacks a role assignment on a **linked** resource named in the error (e.g. a subnet, DDoS plan, or route table) | Grant the identity the action shown in the error at the **linked** resource scope; verify role-assignment propagation and that the linked resource still exists |
| `OrasPullUnauthorizedVMExtensionError` / `vmssCSE` exit **212** | On a network-isolated cluster (outbound `none`/`block`), the kubelet identity can't pull bootstrap images from the private ACR cache | Ensure the kubelet identity has `AcrPull` (or the ABAC repository-reader role) on the bootstrap ACR and is bound to the VM |
| `NodePoolMcVersionIncompatible` | A node pool is (or would become) more than 3 minor versions behind the control plane | Upgrade the node pool to a version ≤ the control-plane version; don't skip minor versions |
| `NodeImageVersion ... is not accepted` | A snapshot- or rollback-pinned node pool is being set to a node-image version that isn't its current version or `latest` | Use `az aks nodepool upgrade --node-image-only` (no `--snapshot-id`) to move to the latest supported image, respecting the OS SKU |

The full catalog — with every error string, the mechanism, and the exact reference — is in [references/error-code-map.md](references/error-code-map.md). Keep that file the single source of truth and add new entries there as documented issues are confirmed.

## Boundary

This skill owns **named, documented** failures. Anything without a specific error signature — a pod crashing, a node going NotReady, DNS or ingress misbehaving, intermittent timeouts — is a live investigation and belongs to `aks-troubleshooting`, which will route to a packet capture (`aks-network-capture`) or another skill as the evidence dictates.
