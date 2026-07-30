# KAITO (AI toolchain operator) Day-2

KAITO = Kubernetes AI Toolchain Operator, shipped as the AKS managed add-on "AI toolchain operator" (enabled with `--enable-ai-toolchain-operator --enable-oidc-issuer` — OIDC issuer is required). A `Workspace` CR provisions GPU nodes on demand (NodeClaim → Karpenter/gpu-provisioner) and serves the model with **vLLM** (OpenAI-compatible API). This file is Day-2 only; for enablement use `azure-skills airunway-aks-setup`.

## Symptom: Workspace never becomes ready

First, **do not declare failure early**: node readiness takes up to ~10 minutes and Workspace readiness up to ~20 minutes depending on model size.

Primary triage — dump the status conditions:

```bash
kubectl get workspace <name> -w
kubectl get workspace <name> -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}: {.message}{"\n"}{end}'
kubectl describe workspace <name>
```

Condition types (from `WorkspaceSucceeded` back to the first failing one): `ResourceReady` (GPU node pool created) → `NodeClaimReady` (claim provisioned) → `NodesReady` (nodes joined) → `InferenceReady` (vLLM ready) → `WorkspaceSucceeded` (summary; True = serving). Whichever is first non-True points at the layer.

Causes, in order:

1. **Subscription lacks GPU quota** for the Workspace `instanceType` in that region — the #1 cause. Raise quota for the GPU VM family (see gpu-scheduling.md).
2. **The `instanceType` isn't available in the AKS region** — switch region.
3. **NodeClaim stuck** — check `kubectl get nodeclaims -A` and `kubectl logs -n kube-system -l app=gpu-provisioner --tail=100`. NodeClaim names must be 1–11 chars, start with a letter, alnum only, and carry the `kaito.sh/workspace` label.
4. **Existing-GPU mismatch** — if you point KAITO at pre-existing nodes, they must carry the label in `resource.labelSelector` **and** their `node.kubernetes.io/instance-type` must equal `resource.instanceType`, or nothing schedules.
5. **Private/gated model** — a gated Hugging Face model needs `inference.preset.presetOptions.modelAccessSecret` (HF token) and/or `imagePullSecrets`; a missing secret shows as an image/model pull failure.
6. **OOM on weight load** — KAITO runs a pre-provisioning GPU-memory check; the annotation `kaito.sh/bypass-resource-checks` overrides it (dangerous — it can then OOM). Match the SKU to the model size (see gpu-observability.md).

## The cost trap: deleting a Workspace does NOT delete its GPU node pool

Deleting the `Workspace` CR leaves the provisioned GPU node pool running — you keep paying for the GPU until you remove it manually. Find and delete it:

```bash
kubectl get nodes -l kaito.sh/workspace=<name> -o name
az aks nodepool list -g <rg> --cluster-name <cluster> -o table   # find the pool labeled kaito.sh/workspace:<name>
az aks nodepool delete -g <rg> --cluster-name <cluster> -n <pool>
```

Also: `az aks stop` / `az aks start` is **not fully supported** with active KAITO Workspaces (can cause node-pool reconciliation conflicts, provisioning failures, and orphaned compute).

## Workspace shape (to recognize a misconfiguration)

`kaito.sh/v1beta1`, kind `Workspace`:
- `resource.instanceType` — the GPU SKU (e.g. `Standard_NC24ads_A100_v4`).
- `resource.labelSelector.matchLabels` — **required**; labels/selects the GPU nodes.
- `inference.preset.name` — a supported model (e.g. `phi-4-mini-instruct`, `llama-3.1-8b-instruct`, `qwen2.5-coder-32b-instruct`, `deepseek-r1-...`, `gpt-oss-20b/120b`), OR `inference.template` for a custom vLLM-served model (mutually exclusive with preset).
- `resource.count` and `resource.preferredNodes` are **deprecated** in v1beta1; `resource.partition.mode: mig` schedules on a MIG slice.

Test the endpoint once ready:

```bash
SERVICE_IP=$(kubectl get svc <name> -o jsonpath='{.spec.clusterIP}')
kubectl run -it --rm --restart=Never curl --image=curlimages/curl -- \
  curl -X POST http://$SERVICE_IP/v1/completions -H 'Content-Type: application/json' \
  -d '{"model":"<model>","prompt":"hi","max_tokens":10}'
```

Limitations to remember: Windows and Azure Linux node OS SKUs are unsupported as KAITO Workspace nodes; AMD GPU SKUs are not valid `instanceType`s; the add-on runs in public Azure regions only. The add-on pins a specific KAITO version (docs have shown 0.3.1 / 0.4.4 / 0.6.0 across pages) — confirm the live pin, since it gates model availability.
