# Capability Provider and Evidence Contract

This is the normative contract between an AKS skill, a host, and any provider
that supplies live Azure or Kubernetes operations. AKS Skills owns semantic
intent and evidence handling; hosts own tool names and provider setup.

The machine-readable registry is
[`providers/capabilities.yaml`](../providers/capabilities.yaml). Provider
bindings live beside it. When this document and a provider binding disagree,
the stricter safety rule applies and the binding must be corrected.

## 1. Semantic capabilities

Skills MUST declare semantic capability IDs in `metadata.capabilities`; they
MUST NOT declare provider tool names or host-rendered aliases. A semantic ID
describes the operation and mode, such as `azure.aks.cluster.read`, independent
of whether Azure MCP Server, `Azure/aks-mcp`, a built-in host tool, or a direct
CLI supplies it.

Hosts MUST discover providers and tools from their advertised descriptions and
input schemas at runtime. A provider map is a tested compatibility binding, not
permission to call a tool whose advertised schema does not match. Host aliases
MAY be recorded as debug metadata after discovery, but MUST NOT be persisted in
provider maps or skill declarations.

The requirement modes are finite:

| Mode | Meaning |
| --- | --- |
| `required` | The skill cannot complete its core task without this capability or an allowed equivalent fallback. |
| `preferred` | Use the capability when compatible; absence or unsupported operation may use the declared fallback or continue with reduced evidence. |
| `conditional` | The capability applies only when the declaration's required `when` condition is true. |
| `live-only` | The capability is required only to collect live evidence. Offline inputs and bundled references remain usable without it. |

An empty `capabilities: []` declaration is valid and means the skill has no
live provider dependency.

## 2. Preflight and identity

Before any live operation, the host MUST resolve and compare:

- Azure tenant, subscription, resource group, and cluster;
- Kubernetes kube-context and namespace when the operation is Kubernetes-scoped;
- the identity kind used by the selected provider; and
- the authorization result for the proposed operation.

The preflight MUST stop on an unresolved or mismatched target. It MUST NOT
silently change a subscription, kube-context, namespace, or cluster to make an
operation succeed.

Record only the identity kind (for example user, service principal, managed
identity, or workload identity) and the authorization result. Tokens, secrets,
credentials, full object IDs, and reusable authentication material MUST NOT
enter prompts, evidence envelopes, logs, or reports.

## 3. Operation selection and mutations

Choose the compatible operation with the smallest scope and least privilege.
Reads default to `readonly`. A provider's configured access level is a damage
guardrail; it is not authentication, authorization, or user approval.

Every mutation requires explicit approval for exactly one proposed action and
one resolved target. The approval prompt MUST include the exact command or
diff, the target scope/context, and the expected effect. A different command,
target, namespace, resource, or retry requires new approval. Batched file edits
are one action only when presented as one combined diff.

## 4. Fail-closed fallback

Fallback is a compatibility path, never an authorization bypass:

| Provider outcome | Required behavior |
| --- | --- |
| `absent` | MAY use the declared direct CLI, built-in provider, or offline fallback after the same preflight. |
| `unsupported` | MAY use the declared fallback after the same preflight. |
| `authorization-denied` | MUST stop. A different provider or CLI under the same identity does not authorize the operation. |
| `context-mismatch` | MUST stop until the user resolves or explicitly selects the target context. |
| `error` | Report the error. Do not relabel it as absent or unsupported. |

Direct Azure and Kubernetes CLIs are providers under this contract. They use
the same identity, target, approval, redaction, and evidence rules.

## 5. Evidence ingestion

Provider output MUST pass through an operation-specific allowlist projection
before model ingestion. Include only fields needed for the active decision.
Exclude secrets, tokens, kubeconfigs, credentials, environment dumps, full
resource bodies, and unrelated identifiers. If a safe projection is not
defined, do not ingest the raw output; retain a digest and request a narrower
operation.

Every live observation produces this normalized evidence envelope:

```yaml
contract_version: "1.0"
semantic_capability: azure.aks.cluster.read
provider:
  id: azure-mcp
  version: 3.0.0-beta.32
  published_operation: aks cluster get
  host_alias_debug: null
operation_mode: read
target:
  azure:
    tenant: redacted-or-digest
    subscription: redacted-or-digest
    resource_group: redacted-or-digest
    cluster: redacted-or-digest
  kubernetes:
    context: redacted-or-digest
    namespace: redacted-or-digest
identity_kind: user
observation:
  observed_at: 2026-08-21T00:00:00Z
  window: null
authorization: allowed
approval: not-required
result: success
redaction_profile: aks-evidence-v1
source:
  excerpt: "allowlisted fields only"
  digest: sha256:...
fallback:
  reason: null
  target: null
```

Required fields are `contract_version`, `semantic_capability`, provider ID,
provider version, published operation, `operation_mode`, target Azure scope and
Kubernetes context, `identity_kind`, observation time/window, `authorization`,
`approval`, `result`, `redaction_profile`, source excerpt or digest, and
fallback reason/target. `host_alias_debug` is optional debug metadata only.
`result` is one of `success`, `denied`, `unsupported`, or `error`.
Sensitive identifiers MAY be omitted, truncated, or digested; full sensitive
identifiers and secrets are never required.

## 6. Provider compatibility

Each provider binding MUST pin the exact tested provider version and source
release, with no `latest`, range, or floating branch. Every mapping names a
published operation, operation class (`read`, `write`, or `privileged`),
context source, fallback class, and the schema constraints tested for that
semantic capability.

At runtime, both the provider version and the advertised operation/schema MUST
match the binding. A version match alone is insufficient. An unlisted
operation is unsupported until its source is verified, mapped, and covered by
the mechanical contract tests.
