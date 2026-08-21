# Provider setup by host

AKS Skills is host-portable; MCP configuration is not. This page is the
authoritative setup location for the hosts whose current primary documentation
proves a usable path.

The repository automatically supplies only:

- the portable skills in `skills/`;
- plugin manifests that point compatible plugin hosts at those skills; and
- root [`.mcp.json`](../.mcp.json), containing only
  `@azure/mcp@3.0.0-beta.32` in the provider's read-only mode.

Every identity, repository or folder trust decision, cloud-job dependency,
connector, and tool permission remains an explicit host or operator
responsibility. The normative preflight, identity, approval, fallback, and
evidence rules are in the
[Capability Provider and Evidence Contract](capability-provider-contract.md);
this page does not redefine them.

## Responsibility matrix

| Host | Automatic from this repository | Explicit operator step |
| --- | --- | --- |
| GitHub Copilot CLI | Plugin installation registers the skills and bundled Azure MCP Server definition. Process start timing may be lazy. | Trust the source, provide Azure identity, and approve or policy-allow the intended read-only tools. |
| GitHub Copilot cloud agent | Nothing in root `.mcp.json` is imported into repository settings. | A repository administrator enters MCP JSON in settings, arranges dependencies and Azure identity inside the agent job, and allowlists named read-only tools. |
| Claude Code | Plugin installation loads the skills and bundled Azure MCP Server definition. | Trust the marketplace/repository, provide Azure identity, and approve the server/tools. Configure any optional local `Azure/aks-mcp` server separately. |
| Codex CLI | No native Codex plugin is shipped. | Install or link the skills and create MCP entries in the consuming trusted project's `.codex/config.toml`. |
| Azure SRE Agent | URL plugin import loads the skills and records the bundled Azure MCP Server requirement. | Use built-in tools, or separately provision and authenticate an MCP connector if the external provider is required. |
| HolmesGPT | Nothing is installed automatically. | Point Holmes at `skills/`; local Holmes CLI may separately launch a local stdio provider. |
| Azure Portal | No import or local-process integration is proven. | No supported setup step is published here. |

Hosts render their own server and tool names. Those names are not part of the
skill contract and must not be persisted in skills or provider maps.

## Shared trust and mutation boundary

The local providers below execute with the identity and environment of the
process that starts them:

- Azure MCP Server uses its configured Azure credential source.
- The optional `Azure/aks-mcp` v0.0.20 binary executes local Azure and
  Kubernetes commands with the user's existing CLI and kubeconfig authority.

Only start either process in a repository or folder you trust. Resolve the
tenant, subscription, cluster, kube-context, and namespace before live work.
The root Azure MCP Server process is started with `--read-only`. The optional
`Azure/aks-mcp` server defaults to and is shown with `--access-level readonly`,
but that flag is an accidental-damage guardrail, not authentication,
authorization, sandboxing, or user approval.

Direct CLI fallback does not bypass a failed provider authorization or target
mismatch. It remains governed by the normative contract linked above.

## GitHub Copilot CLI

### Plugin path

Run:

```text
/plugin marketplace add Azure/AKS-Skills
/plugin install aks@aks-skills
```

The plugin manifest registers `skills/` and root `.mcp.json`. A second MCP
registration is not required. GitHub documents plugin MCP registration but
does not guarantee that the subprocess has connected when the install command
returns; startup may occur on first use.

MCP calls remain subject to Copilot CLI permission and enterprise MCP policy.
Plugin installation does not authenticate Azure or grant provider access.

### Project and user configuration

Copilot CLI reads project `.mcp.json` files and the user file
`~/.copilot/mcp-config.json` (or `$COPILOT_HOME/mcp-config.json`). This
repository's root file is the shared project definition when working in this
checkout. To use the same provider outside the plugin, place this shape in the
consumer project or user file:

```json
{
  "mcpServers": {
    "azure": {
      "type": "local",
      "command": "npx",
      "args": [
        "-y",
        "@azure/mcp@3.0.0-beta.32",
        "server",
        "start",
        "--read-only"
      ],
      "tools": [
        "<verified-read-only-tool-name>"
      ]
    }
  }
}
```

Replace the placeholder only after inspecting the server's advertised tools;
do not use a host-generated name from another environment. Project MCP files
are skipped until the working directory is trusted. Tool filtering and saved
permissions are separate controls: a `tools` entry makes a tool available but
does not itself authorize Azure or approve an invocation.

Primary sources:
[Copilot CLI MCP configuration](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers),
[plugin manifests](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference#pluginjson),
and [MCP permissions and trust](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#mcp-server-trust-levels).

## GitHub Copilot cloud agent

Repository administrators configure MCP at **Repository settings > Copilot >
MCP servers > MCP configuration**. The cloud agent does not consume this
repository's root `.mcp.json` as repository-settings configuration.

Use a non-wildcard read-only allowlist:

```json
{
  "mcpServers": {
    "azure": {
      "type": "local",
      "command": "npx",
      "args": [
        "-y",
        "@azure/mcp@3.0.0-beta.32",
        "server",
        "start",
        "--read-only"
      ],
      "tools": [
        "<verified-read-only-tool-name>"
      ]
    }
  }
}
```

Here `local` means a subprocess inside the cloud agent's ephemeral
GitHub-Actions-powered job. It does not reach a developer-workstation process,
credential store, Azure CLI session, or kubeconfig. Install any missing runtime
dependency through the repository's cloud-agent setup flow. Configure an
approved job identity separately; only Agents secrets or variables with the
documented `COPILOT_MCP_` prefix can be substituted into MCP settings.

Cloud-agent MCP tools run autonomously without an interactive approval prompt.
Keep the server in read-only mode and replace the placeholder with an explicit
read-only tool allowlist. Do not use a wildcard unless a separately reviewed
execution design defines identity, target scope, mutation controls, and
evidence handling.

Primary sources:
[repository MCP settings](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers)
and [cloud-agent secrets and variables](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables).

## Claude Code

The preferred path is the plugin installation shown above. Claude Code loads
plugin skills and the bundled root `.mcp.json`, so Azure MCP Server is
registered automatically with its exact pin and read-only switch. Trust the
repository and approve the provider; installation does not supply Azure
credentials.

For an optional local `Azure/aks-mcp` v0.0.20 process, download and verify the
appropriate [v0.0.20 release asset](https://github.com/Azure/aks-mcp/releases/tag/v0.0.20),
then add the binary as a local-scope stdio server in the consuming project:

```bash
claude mcp add --scope local --transport stdio aks-local -- \
  /absolute/path/to/server-binary --access-level readonly
```

Local scope keeps the entry private to the current project/user pairing and
does not add the separate provider to this repository's root `.mcp.json`.
The process uses the local user's Azure CLI and kubeconfig authority.

Do not encode Claude-generated MCP tool names in skills. They are valid only
inside Claude's current permission and hook surfaces, not across hosts.

Primary sources:
[Claude plugin MCP servers](https://code.claude.com/docs/en/plugins-reference#mcp-servers),
[Claude local stdio setup](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server),
the pinned [`Azure/aks-mcp` v0.0.20 boundary](https://github.com/Azure/aks-mcp/blob/8d28bece75d1f572293364d7f50a7e9d2e425efa/README.md#supported-deployment-model-and-security-considerations),
and its [stdio implementation](https://github.com/Azure/aks-mcp/blob/8d28bece75d1f572293364d7f50a7e9d2e425efa/internal/server/server.go#L125-L131).

## Codex CLI

This repository does not ship a native Codex plugin manifest. Install or
symlink each directory under `skills/` into the consuming repository's
`.agents/skills/` directory, or into `~/.agents/skills/` for an intentional
user-wide installation.

Create `.codex/config.toml` only in the consuming trusted repository. Do not
commit a universal user configuration from this repository:

```toml
[mcp_servers.azure]
command = "npx"
args = ["-y", "@azure/mcp@3.0.0-beta.32", "server", "start", "--read-only"]

[mcp_servers.aks_local]
command = "/absolute/path/to/server-binary"
args = ["--access-level", "readonly"]
```

The second entry is optional and represents a local `Azure/aks-mcp` v0.0.20
stdio process. Codex loads project `.codex/config.toml` only after the project
is trusted. Neither entry supplies credentials or changes the provider's
process identity.

Primary sources:
[Codex MCP configuration](https://developers.openai.com/codex/mcp/),
[Codex project configuration](https://developers.openai.com/codex/config-basic/),
and [Codex skill locations](https://developers.openai.com/codex/skills/#where-codex-loads-local-skills).

## Azure SRE Agent

Install the plugin from URL using `https://github.com/Azure/AKS-Skills`.
That imports the skills and records the bundled Azure MCP Server requirement.
It does not create, authenticate, or connect an MCP connector.

Use the agent's built-in Azure operations, AKS diagnostics, Azure Monitor, and
`kubectl` capabilities when they satisfy the semantic requirement. Those
built-ins use the agent's managed identity and do not require a connector. If
the external Azure MCP Server surface is required and the plugin reports
**Connector setup required**, an operator must separately add the connector,
complete authentication, wait for connection, and select the allowed tools.

No current primary source proves that Azure SRE Agent hosts or consumes the
`Azure/aks-mcp` v0.0.20 server. Generic stdio connector support is not proof of
a supported binary distribution, identity design, or runtime boundary for
that product. The exact consumption and hosting path remains pending
owner/runtime confirmation; this guide intentionally publishes no connector
recipe for it.

Primary sources:
[plugin import from URL](https://learn.microsoft.com/azure/sre-agent/install-plugin-from-url),
[plugin requirement behavior](https://learn.microsoft.com/azure/sre-agent/plugin-marketplace#what-the-plugin-marketplace-does),
[MCP connector setup](https://learn.microsoft.com/azure/sre-agent/mcp-connector),
and [built-in tools](https://learn.microsoft.com/azure/sre-agent/tools#built-in-tools).

## HolmesGPT

HolmesGPT 0.26.0 or newer can consume these skills as an evaluation or
investigation target. Earlier versions use the legacy runbook mechanism. For
local Holmes CLI, point `custom_skill_paths` at this repository's `skills/`
directory. Primary Holmes source also proves a local stdio subprocess shape:

```yaml
custom_skill_paths:
  - /absolute/path/to/AKS-Skills/skills
mcp_servers:
  aks_local:
    description: Local Azure/aks-mcp v0.0.20 process
    config:
      mode: stdio
      command: /absolute/path/to/server-binary
      args:
        - --access-level
        - readonly
```

This local CLI process inherits the trusted user's Azure CLI and kubeconfig
authority. It is not a multi-user service.

Holmes also documents a generic gateway pattern for Kubernetes-hosted stdio
servers. Do not apply that pattern to the `Azure/aks-mcp` v0.0.20 server:
its pinned source supports only local single-user stdio and explicitly excludes
HTTP, SSE, containers, Helm/Kubernetes hosting, proxies, gateways, and
third-party bridges. Holmes-on-Kubernetes cannot reach a developer-workstation
process through any supported path documented here.

Primary sources:
[Holmes Skills](https://github.com/HolmesGPT/holmesgpt/blob/87333f17b33985680a77525e1cc3a775eaf77b91/docs/reference/skills.md),
[Holmes stdio MCP configuration](https://github.com/HolmesGPT/holmesgpt/blob/87333f17b33985680a77525e1cc3a775eaf77b91/docs/data-sources/remote-mcp-servers.md#stdio),
and the pinned [`Azure/aks-mcp` v0.0.20 support boundary](https://github.com/Azure/aks-mcp/blob/8d28bece75d1f572293364d7f50a7e9d2e425efa/README.md#supported-deployment-model-and-security-considerations).

## Azure Portal

Portal is the intended self-service/free-user product lane, not a setup path
proven by this repository. No current primary source proves that the general
Azure Portal imports AKS Skills, launches a developer-local process, or
consumes the `Azure/aks-mcp` v0.0.20 server.

The Azure SRE Agent portal is a different surface and uses the plugin import
and connector flow documented above. Until a Portal owner supplies a public
runtime contract, identity design, and primary integration source, this guide
publishes no Portal installation or hosting instructions.

## Pinned provider evidence

The Azure MCP Server read-only argument is verified at the exact source commit
bound in `providers/azure-mcp.yaml`:

- [`ReadOnly` option and semantics](https://github.com/microsoft/mcp/blob/0fe54df28d473415d63c201b309b64eec0aa6587/core/Microsoft.Mcp.Core/src/Areas/Server/Options/ServerStartOptions.cs#L42-L47)
- [CLI option kebab-case mapping](https://github.com/microsoft/mcp/blob/0fe54df28d473415d63c201b309b64eec0aa6587/core/Microsoft.Mcp.Core/src/Options/OptionAttribute.cs#L6-L24)
- [Pinned read-only invocation](https://github.com/microsoft/mcp/blob/0fe54df28d473415d63c201b309b64eec0aa6587/docs/bug-bash/installation-testing.md)

The separate local provider boundary is verified at the exact source commit
bound in the `Azure/aks-mcp` provider map (`providers/aks-mcp.yaml`):

- [`Azure/aks-mcp` v0.0.20 supported deployment and security boundary](https://github.com/Azure/aks-mcp/blob/8d28bece75d1f572293364d7f50a7e9d2e425efa/README.md#supported-deployment-model-and-security-considerations)
- [`Azure/aks-mcp` v0.0.20 access-level values and default](https://github.com/Azure/aks-mcp/blob/8d28bece75d1f572293364d7f50a7e9d2e425efa/internal/config/config.go#L37-L58)
