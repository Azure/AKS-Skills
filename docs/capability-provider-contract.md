# Capability and Provider Compatibility Contract

This contract defines only the metadata AKS Skills owns: semantic capability
requirements, fail-closed fallback outcomes, and source-verified provider
compatibility. It does not define a host runtime, grant permission, or turn
descriptive metadata into target, authorization, approval, or output controls.

The semantic registry is
[`providers/capabilities.yaml`](../providers/capabilities.yaml). Exact tested
provider operations and input schemas live beside it.

## 1. Semantic capabilities

Skills declare semantic capability IDs in `metadata.capabilities`, not provider
tool names or host-rendered aliases. A semantic ID describes the operation and
mode, such as `azure.aks.cluster.read`, independent of whether Azure MCP Server,
`Azure/aks-mcp`, a built-in host tool, or a direct CLI supplies it.

The requirement modes are finite:

| Mode | Meaning |
| --- | --- |
| `required` | The skill cannot complete its core task without this capability or an allowed equivalent fallback. |
| `preferred` | Use the capability when compatible; absence or unsupported operation may use the declared fallback or continue with reduced evidence. |
| `conditional` | The capability applies only when the declaration's required `when` condition is true. |
| `live-only` | The capability is required only to collect live evidence. Offline inputs and bundled references remain usable without it. |

An empty `capabilities: []` declaration is valid and means the skill has no
live provider dependency.

## 2. Fail-closed fallback

Fallback is a compatibility path, never an authorization bypass:

| Provider outcome | Required behavior |
| --- | --- |
| `absent` | The capability may use another available implementation or offline input. |
| `unsupported` | The capability may use another available implementation or offline input. |
| `authorization-denied` | Stop. A different provider or CLI is not an authorization bypass. |
| `context-mismatch` | Stop until the target context is resolved. |
| `error` | Report the error. Do not relabel it as absent or unsupported. |

## 3. Provider compatibility

Each provider file pins the exact tested version, release, and source commit.
Its `operations` map is the single checked-in source of operation names and
input schemas. The schema projection records every published input name and
whether it is required or optional; provider descriptions and defaults are not
duplicated. `capability_bindings` may only reference a declared, bindable
operation. An unlisted operation is unsupported by that provider map.

Provider files are compatibility evidence, not runtime enforcement. They do not
claim that a provider enforces target preflight, identity authorization, user
approval, bounded duration, namespace scope, redaction, or safe output
projection. A provider access-level setting or MCP annotation is likewise not
user approval or authorization.

An operation is `bindable: false` when its real schema cannot satisfy a
necessary target precondition that this repository has no runtime to enforce.
The pinned `Azure/aks-mcp` v0.0.20 `call_kubectl` registration delegates to
`Azure/mcp-kubernetes` v0.0.14: it accepts only `command` and operates on the
process's current kube context. It is therefore recorded for schema truth but
has no AKS Skills capability binding.

The pinned packet-capture provider is also unbound. Its tool does not enforce
per-capture approval, bounded duration, namespace scope, or safe output
projection. The `kubernetes.packet-capture.collect` semantic capability remains
available to implementations that actually provide their own safeguards; this
provider map does not claim them.

## 4. Mechanical checks

The linter verifies exact provenance pins, canonical operation-map integrity,
binding references, and unsupported-capability exclusions. It rejects floating
versions, host aliases, fictional operation inputs, and enforcement-shaped
fields such as `approval_required` in provider compatibility metadata.
