#!/usr/bin/env node
/**
 * Skill Contract Linter — validates SKILL.md against docs/skill-contract.md.
 * Uses js-yaml for front-matter parsing and Git for index-mode checks.
 *
 * Checks (see docs/skill-contract.md for the authoritative rule):
 *  1. SKILL.md exists in each skill folder
 *  2. Valid contract-shaped YAML front matter
 *  3. Required fields present, in the contract's declared order:
 *     name, license, metadata.author, metadata.version, description
 *  4. metadata.capabilities uses known semantic IDs and requirement modes
 *  5. provider maps use the pinned, published compatibility surface
 *  6. name === folder name (error)
 *  7. metadata.version is valid semver
 *  8. license === "MIT", metadata.author === "Microsoft" (contract §2 exact values)
 *  9. description contains a WHEN: clause and a DO NOT USE FOR: clause that
 *     uses the parenthetical-redirect grammar ("(use X)" / "(see X)")
 * 10. description respects the contract's declared routing budget (~2000 chars)
 * 11. every skill has non-empty evals/tests/<skill>/{trigger,quality}-tests.yaml
 * 12. every skill's quality-tests.yaml is wired into evals/promptfooconfig.yaml
 * 13. every script-shaped file in scripts/ has a valid shebang and Git mode 100755
 * 14. internal file references in SKILL.md resolve to real files
 * 15. shipped guidance preserves Azure MCP host portability and product boundaries
 *
 * Usage:
 *   node lint-skills.js [skills-dir]
 *   Default skills-dir: ../skills
 *
 * Env overrides (used by lint-skills.test.js to point at fixture directories;
 * not needed for normal use — defaults match the real repo layout):
 *   LINT_TESTS_DIR            default: <repo>/evals/tests
 *   LINT_PROMPTFOO_CONFIG     default: <repo>/evals/promptfooconfig.yaml
 *   LINT_PROVIDERS_DIR        default: <repo>/providers
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

// --- Contract-declared exact values (docs/skill-contract.md §2) ---------
// Do not invent new thresholds here; these mirror the contract's own numbers.
const EXPECTED_LICENSE = 'MIT';
const EXPECTED_AUTHOR = 'Microsoft';
// "keep it under ~500 tokens (~2000 characters)" — the contract's only declared
// budget is the character approximation; that's what CI can enforce mechanically.
const MAX_DESCRIPTION_CHARS = 2000;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
// Declared order from the contract's manifest example (§2).
const REQUIRED_TOP_LEVEL_ORDER = ['name', 'license', 'metadata', 'description'];
const REQUIRED_METADATA_ORDER = ['author', 'version', 'capabilities'];
const REQUIRED_TOP_LEVEL_FIELDS = ['name', 'license', 'metadata', 'description'];
const VALID_SHEBANG_RE = /^#!\/\S+(?:\s+.*)?$/;
const SCRIPT_EXTENSIONS = new Set(['.sh', '.py']);
const HARDCODED_AZURE_MCP_NAME_RE = /\bmcp_azure_mcp_[A-Za-z0-9_]+\b/i;
const AKS_MCP_PRODUCT_NAME_RE = /\bAKS[- ]MCP\b/i;
const EXPLICIT_AKS_MCP_PRODUCT_RE = /\bAzure\/aks-mcp\b/i;
const REMOVED_READINESS_API_PATTERNS = [
  {
    label: 'readiness discovery action',
    pattern: /\baction\s*[:=]\s*["']?discover\b/i,
  },
  {
    label: 'readiness polling action',
    pattern: /\bpollOperation\b/i,
  },
  {
    label: 'HTTP 202 readiness polling contract',
    pattern: /\bHTTP\s*-?\s*202\b/i,
  },
  {
    label: 'invented readiness response field',
    pattern: /\b(?:clusterConfiguration|totalWorkloads|overallStatus|suggestedPatch|remediationGuide)\b/,
  },
];
const VALID_REQUIREMENT_MODES = new Set(['required', 'preferred', 'conditional', 'live-only']);
const ALLOWED_FALLBACK_REASONS = ['absent', 'unsupported'];
const STOP_FALLBACK_REASONS = ['authorization-denied', 'context-mismatch'];
const DEFAULT_PROVIDERS_DIR = path.join(__dirname, '..', 'providers');
const PINNED_PROVIDER_PROVENANCE = {
  'azure-mcp': {
    product: 'Azure MCP Server',
    version: '3.0.0-beta.32',
    releaseRef: 'Azure.Mcp.Server-3.0.0-beta.32',
    sourceCommit: '0fe54df28d473415d63c201b309b64eec0aa6587',
    sourceUrl: 'https://github.com/microsoft/mcp/tree/Azure.Mcp.Server-3.0.0-beta.32/tools/Azure.Mcp.Tools.Aks',
    package: '@azure/mcp',
    contractDigest: '1672204c28b7c2c3bec11dc2d9c055fd50cfc6b55d1a386a2671c38b39215be5',
  },
  'aks-mcp': {
    product: 'Azure/aks-mcp',
    version: '0.0.20',
    releaseRef: 'v0.0.20',
    sourceCommit: '8d28bece75d1f572293364d7f50a7e9d2e425efa',
    sourceUrl: 'https://github.com/Azure/aks-mcp/tree/v0.0.20',
    contractDigest: '5bba8ccd8bb557fb6c6b93a45b1651d61cb49dc6c6303c80cfc64d4408ed4c58',
    dependencies: {
      'mcp-kubernetes': {
        product: 'Azure/mcp-kubernetes',
        version: '0.0.14',
        releaseRef: 'v0.0.14',
        sourceCommit: '39b7de1c2b8aec39a52ebade30aed981bb0725d5',
        sourceUrl: 'https://github.com/Azure/mcp-kubernetes/tree/v0.0.14',
      },
    },
  },
};
const HOST_ALIAS_RE = /\b(?:mcp__|mcp_azure_mcp_|plugin_aks_azure__)[A-Za-z0-9_-]*/i;

/**
 * Read a text file with line endings normalized to LF. Windows checkouts
 * materialize CRLF; lint must report the same results on every platform.
 */
function readText(filePath) {
  return fs.readFileSync(filePath, 'utf-8').replace(/\r\n?/g, '\n');
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual)) return false;
  return actual.length === expected.length
    && [...actual].sort().join('\n') === [...expected].sort().join('\n');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isMapping(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
  );
}

function stableDigest(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function walkScalars(value, visit) {
  if (Array.isArray(value)) {
    value.forEach(item => walkScalars(item, visit));
  } else if (isMapping(value)) {
    Object.entries(value).forEach(([key, item]) => {
      visit(key);
      walkScalars(item, visit);
    });
  } else if (value !== null && value !== undefined) {
    visit(String(value));
  }
}

function parseYamlFile(filePath) {
  return yaml.load(readText(filePath));
}

function checkAllowedKeys(value, allowedKeys, addError, filePath, location) {
  if (!isMapping(value)) return;
  const extras = Object.keys(value).filter(key => !allowedKeys.includes(key));
  if (extras.length > 0) {
    addError(filePath, `${location} contains non-canonical field(s): ${extras.join(', ')}`);
  }
}

function loadCapabilityVocabulary(providersDir) {
  const registry = parseYamlFile(path.join(providersDir, 'capabilities.yaml'));
  return {
    capabilityIds: new Set(
      Array.isArray(registry?.capabilities)
        ? registry.capabilities.map(capability => capability?.id).filter(Boolean)
        : [],
    ),
    requirementModes: new Set(
      Array.isArray(registry?.requirement_modes) ? registry.requirement_modes : [],
    ),
  };
}

function loadProviderOperationNames(providersDir) {
  const names = new Set();
  for (const providerId of Object.keys(PINNED_PROVIDER_PROVENANCE)) {
    const providerPath = path.join(providersDir, `${providerId}.yaml`);
    const binding = parseYamlFile(providerPath);
    if (!isMapping(binding?.operations)) continue;
    Object.keys(binding.operations).forEach(name => names.add(name));
  }
  return names;
}

function validateFallbackPolicy(policy, addError, filePath) {
  if (!isMapping(policy)) {
    addError(filePath, 'fallback_policy must be a YAML mapping');
    return;
  }
  checkAllowedKeys(
    policy,
    ['allowed_reasons', 'stop_reasons'],
    addError,
    filePath,
    'fallback_policy',
  );
  if (!sameStringSet(policy.allowed_reasons, ALLOWED_FALLBACK_REASONS)) {
    addError(
      filePath,
      `fallback_policy.allowed_reasons must be exactly [${ALLOWED_FALLBACK_REASONS.join(', ')}]`,
    );
  }
  if (!sameStringSet(policy.stop_reasons, STOP_FALLBACK_REASONS)) {
    addError(
      filePath,
      `fallback_policy.stop_reasons must be exactly [${STOP_FALLBACK_REASONS.join(', ')}]`,
    );
  }
}

function lintProviderContracts({ providersDir, repoRoot }) {
  const errors = [];
  const addError = (filePath, message) => {
    errors.push(`ERROR [${path.relative(repoRoot, filePath)}]: ${message}`);
  };
  const registryPath = path.join(providersDir, 'capabilities.yaml');

  if (!fs.existsSync(registryPath)) {
    addError(registryPath, 'capability registry is missing');
    return errors;
  }

  let registry;
  try {
    registry = parseYamlFile(registryPath);
  } catch (error) {
    addError(registryPath, `invalid YAML: ${error.message}`);
    return errors;
  }

  if (!isMapping(registry)) {
    addError(registryPath, 'capability registry must be a YAML mapping');
    return errors;
  }
  checkAllowedKeys(
    registry,
    ['contract_version', 'requirement_modes', 'fallback_policy', 'capabilities'],
    addError,
    registryPath,
    'capability registry',
  );
  if (registry.contract_version !== '1.0') {
    addError(registryPath, 'contract_version must be exactly "1.0"');
  }
  if (!sameStringSet(registry.requirement_modes, [...VALID_REQUIREMENT_MODES])) {
    addError(registryPath, 'requirement_modes do not match the contract vocabulary');
  }
  validateFallbackPolicy(registry.fallback_policy, addError, registryPath);

  if (!Array.isArray(registry.capabilities) || registry.capabilities.length === 0) {
    addError(registryPath, 'capabilities must be a non-empty list');
  }
  const registryIds = Array.isArray(registry.capabilities)
    ? registry.capabilities.map(capability => capability?.id)
    : [];
  if (new Set(registryIds).size !== registryIds.length) {
    addError(registryPath, 'capability IDs must be unique');
  }
  if (Array.isArray(registry.capabilities)) {
    registry.capabilities.forEach((capability, index) => {
      const location = `capabilities[${index}]`;
      if (!isMapping(capability)) {
        addError(registryPath, `${location} must be a YAML mapping`);
        return;
      }
      checkAllowedKeys(capability, ['id', 'description'], addError, registryPath, location);
      if (typeof capability.id !== 'string' || capability.id.trim() === '') {
        addError(registryPath, `${location}.id must be a non-empty string`);
      }
      if (typeof capability.description !== 'string' || capability.description.trim() === '') {
        addError(registryPath, `${location}.description must be a non-empty string`);
      }
    });
  }
  const knownCapabilityIds = new Set(registryIds.filter(Boolean));
  const parsedProviders = new Map();

  for (const [providerId, expected] of Object.entries(PINNED_PROVIDER_PROVENANCE)) {
    const filePath = path.join(providersDir, `${providerId}.yaml`);
    if (!fs.existsSync(filePath)) {
      addError(filePath, `provider map for "${providerId}" is missing`);
      continue;
    }

    let binding;
    try {
      binding = parseYamlFile(filePath);
    } catch (error) {
      addError(filePath, `invalid YAML: ${error.message}`);
      continue;
    }
    if (!isMapping(binding) || !isMapping(binding.provider)) {
      addError(filePath, 'provider map and provider field must be YAML mappings');
      continue;
    }
    parsedProviders.set(providerId, binding);
    checkAllowedKeys(
      binding,
      [
        'contract_version',
        'provider',
        'dependencies',
        'operations',
        'capability_bindings',
        'unsupported_capabilities',
      ],
      addError,
      filePath,
      'provider map',
    );
    checkAllowedKeys(
      binding.provider,
      ['id', 'product', 'package', 'version', 'release_ref', 'source_commit', 'source_url'],
      addError,
      filePath,
      'provider',
    );
    if (binding.contract_version !== '1.0') {
      addError(filePath, 'contract_version must be exactly "1.0"');
    }
    if (binding.provider.id !== providerId) {
      addError(filePath, `provider.id must be "${providerId}"`);
    }
    if (String(binding.provider.version) !== expected.version) {
      addError(filePath, `provider.version must be exact tested version "${expected.version}"`);
    }
    if (binding.provider.release_ref !== expected.releaseRef) {
      addError(filePath, `provider.release_ref must be "${expected.releaseRef}"`);
    }
    if (binding.provider.source_commit !== expected.sourceCommit) {
      addError(filePath, `provider.source_commit must be "${expected.sourceCommit}"`);
    }
    if (expected.package && binding.provider.package !== expected.package) {
      addError(filePath, `provider.package must be "${expected.package}"`);
    }
    if (!expected.package && Object.prototype.hasOwnProperty.call(binding.provider, 'package')) {
      addError(filePath, 'provider.package is not part of the pinned provider provenance');
    }
    if (binding.provider.product !== expected.product) {
      addError(filePath, `provider.product must be "${expected.product}"`);
    }
    if (binding.provider.source_url !== expected.sourceUrl) {
      addError(filePath, `provider.source_url must be "${expected.sourceUrl}"`);
    }
    if (/\blatest\b|^[~^<>=*]/i.test(String(binding.provider.version))) {
      addError(filePath, 'provider.version must not use latest or a version range');
    }

    const expectedDependencies = expected.dependencies || {};
    const dependencies = binding.dependencies || {};
    if (!isMapping(dependencies)) {
      addError(filePath, 'dependencies must be a YAML mapping');
    } else if (!sameStringSet(Object.keys(dependencies), Object.keys(expectedDependencies))) {
      addError(filePath, 'dependencies do not match the pinned provider source graph');
    }
    if (isMapping(dependencies)) {
      for (const [dependencyId, expectedDependency] of Object.entries(expectedDependencies)) {
        const dependency = dependencies[dependencyId];
        const location = `dependencies.${dependencyId}`;
        if (!isMapping(dependency)) {
          addError(filePath, `${location} must be a YAML mapping`);
          continue;
        }
        checkAllowedKeys(
          dependency,
          ['product', 'version', 'release_ref', 'source_commit', 'source_url'],
          addError,
          filePath,
          location,
        );
        if (String(dependency.version) !== expectedDependency.version) {
          addError(filePath, `${location}.version must be exact tested version "${expectedDependency.version}"`);
        }
        if (dependency.release_ref !== expectedDependency.releaseRef) {
          addError(filePath, `${location}.release_ref must be "${expectedDependency.releaseRef}"`);
        }
        if (dependency.source_commit !== expectedDependency.sourceCommit) {
          addError(filePath, `${location}.source_commit must be "${expectedDependency.sourceCommit}"`);
        }
        if (dependency.product !== expectedDependency.product) {
          addError(filePath, `${location}.product must be "${expectedDependency.product}"`);
        }
        if (dependency.source_url !== expectedDependency.sourceUrl) {
          addError(filePath, `${location}.source_url must be "${expectedDependency.sourceUrl}"`);
        }
      }
    }

    if (!isMapping(binding.operations) || Object.keys(binding.operations).length === 0) {
      addError(filePath, 'operations must be a non-empty YAML mapping');
    }
    const operations = isMapping(binding.operations) ? binding.operations : {};
    const validSources = new Set(['provider', ...Object.keys(expectedDependencies)]);
    for (const [operationName, operation] of Object.entries(operations)) {
      const location = `operations.${operationName}`;
      if (!isMapping(operation)) {
        addError(filePath, `${location} must be a YAML mapping`);
        continue;
      }
      checkAllowedKeys(
        operation,
        ['source', 'source_paths', 'input_schema', 'bindable', 'unbound_reason'],
        addError,
        filePath,
        location,
      );
      if (!validSources.has(operation.source)) {
        addError(filePath, `${location}.source must name "provider" or a pinned dependency`);
      }
      if (
        !Array.isArray(operation.source_paths)
        || operation.source_paths.length === 0
        || operation.source_paths.some(sourcePath => (
          typeof sourcePath !== 'string'
          || sourcePath.trim() === ''
          || path.isAbsolute(sourcePath)
          || sourcePath.split('/').includes('..')
        ))
      ) {
        addError(filePath, `${location}.source_paths must be a non-empty list of repository-relative paths`);
      }
      if (!isMapping(operation.input_schema)) {
        addError(filePath, `${location}.input_schema must be a YAML mapping`);
      } else {
        checkAllowedKeys(
          operation.input_schema,
          ['required', 'optional'],
          addError,
          filePath,
          `${location}.input_schema`,
        );
        const required = operation.input_schema.required;
        const optional = operation.input_schema.optional;
        for (const [fieldName, values] of [['required', required], ['optional', optional]]) {
          if (!Array.isArray(values) || values.some(name => typeof name !== 'string' || name === '')) {
            addError(filePath, `${location}.input_schema.${fieldName} must be a list of strings`);
          } else if (new Set(values).size !== values.length) {
            addError(filePath, `${location}.input_schema.${fieldName} must not contain duplicates`);
          }
        }
        if (Array.isArray(required) && Array.isArray(optional)) {
          const overlap = required.filter(name => optional.includes(name));
          if (overlap.length > 0) {
            addError(
              filePath,
              `${location}.input_schema inputs cannot be both required and optional: ${overlap.join(', ')}`,
            );
          }
        }
      }
      if (
        Object.prototype.hasOwnProperty.call(operation, 'bindable')
        && typeof operation.bindable !== 'boolean'
      ) {
        addError(filePath, `${location}.bindable must be a boolean`);
      }
      if (
        operation.bindable === false
        && (typeof operation.unbound_reason !== 'string' || operation.unbound_reason.trim() === '')
      ) {
        addError(filePath, `${location}.unbound_reason is required when bindable is false`);
      }
      if (operation.bindable !== false && Object.prototype.hasOwnProperty.call(operation, 'unbound_reason')) {
        addError(filePath, `${location}.unbound_reason is only valid when bindable is false`);
      }
    }

    if (!Array.isArray(binding.capability_bindings)) {
      addError(filePath, 'capability_bindings must be a YAML list');
    }
    if (!Array.isArray(binding.unsupported_capabilities)) {
      addError(filePath, 'unsupported_capabilities must be a YAML list');
    }
    const boundCapabilityIds = new Set();
    if (Array.isArray(binding.capability_bindings)) {
      binding.capability_bindings.forEach((capabilityBinding, index) => {
        const location = `capability_bindings[${index}]`;
        if (!isMapping(capabilityBinding)) {
          addError(filePath, `${location} must be a YAML mapping`);
          return;
        }
        checkAllowedKeys(capabilityBinding, ['capability', 'operation'], addError, filePath, location);
        if (!knownCapabilityIds.has(capabilityBinding.capability)) {
          addError(
            filePath,
            `${location}.capability "${capabilityBinding.capability}" is not a known semantic capability`,
          );
        }
        if (boundCapabilityIds.has(capabilityBinding.capability)) {
          addError(filePath, `${location}.capability "${capabilityBinding.capability}" is duplicated`);
        }
        boundCapabilityIds.add(capabilityBinding.capability);
        const operation = operations[capabilityBinding.operation];
        if (!operation) {
          addError(
            filePath,
            `${location}.operation "${capabilityBinding.operation}" does not name a declared operation`,
          );
        } else if (operation.bindable === false) {
          addError(filePath, `${location}.operation "${capabilityBinding.operation}" is not bindable`);
        }
      });
    }

    const unsupportedCapabilityIds = new Set();
    if (Array.isArray(binding.unsupported_capabilities)) {
      binding.unsupported_capabilities.forEach((unsupported, index) => {
        const location = `unsupported_capabilities[${index}]`;
        if (!isMapping(unsupported)) {
          addError(filePath, `${location} must be a YAML mapping`);
          return;
        }
        checkAllowedKeys(
          unsupported,
          ['capability', 'reason', 'source_paths'],
          addError,
          filePath,
          location,
        );
        if (!knownCapabilityIds.has(unsupported.capability)) {
          addError(
            filePath,
            `${location}.capability "${unsupported.capability}" is not a known semantic capability`,
          );
        }
        if (unsupportedCapabilityIds.has(unsupported.capability)) {
          addError(filePath, `${location}.capability "${unsupported.capability}" is duplicated`);
        }
        unsupportedCapabilityIds.add(unsupported.capability);
        if (typeof unsupported.reason !== 'string' || unsupported.reason.trim() === '') {
          addError(filePath, `${location}.reason must be a non-empty string`);
        }
        if (
          Object.prototype.hasOwnProperty.call(unsupported, 'source_paths')
          && (
            !Array.isArray(unsupported.source_paths)
            || unsupported.source_paths.length === 0
            || unsupported.source_paths.some(sourcePath => typeof sourcePath !== 'string' || sourcePath === '')
          )
        ) {
          addError(filePath, `${location}.source_paths must be a non-empty list of strings`);
        }
        if (boundCapabilityIds.has(unsupported.capability)) {
          addError(filePath, `${location}.capability "${unsupported.capability}" cannot also be bound`);
        }
      });
    }

    const compatibilityContract = {
      operations: binding.operations,
      capability_bindings: binding.capability_bindings,
      unsupported_capabilities: binding.unsupported_capabilities,
    };
    if (stableDigest(compatibilityContract) !== expected.contractDigest) {
      addError(filePath, 'compatibility contract does not match the pinned source digest');
    }

    walkScalars(binding, (scalar) => {
      if (HOST_ALIAS_RE.test(scalar)) {
        addError(filePath, `host-rendered alias "${scalar.match(HOST_ALIAS_RE)[0]}" is forbidden`);
      }
    });
  }

  const mcpConfigPath = path.join(repoRoot, '.mcp.json');
  if (fs.existsSync(mcpConfigPath)) {
    try {
      const config = JSON.parse(readText(mcpConfigPath));
      const args = config?.mcpServers?.azure?.args;
      const packageArg = Array.isArray(args)
        ? args.find(argument => String(argument).startsWith('@azure/mcp@'))
        : null;
      const azureProvider = parsedProviders.get('azure-mcp')?.provider;
      const expectedPackage = azureProvider
        ? `${azureProvider.package}@${azureProvider.version}`
        : null;
      if (packageArg !== expectedPackage) {
        addError(mcpConfigPath, `Azure MCP package must match provider map pin "${expectedPackage}"`);
      }
    } catch (error) {
      addError(mcpConfigPath, `cannot verify Azure MCP package pin: ${error.message}`);
    }
  }

  return errors;
}

function parseYamlScalar(rawValue) {
  const value = rawValue.trim();
  if (value === '') return null;

  if (value.startsWith('"')) {
    if (!value.endsWith('"')) throw new Error('unterminated double-quoted scalar');
    try {
      return JSON.parse(value);
    } catch (e) {
      throw new Error(`invalid double-quoted scalar: ${e.message}`);
    }
  }

  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error('unterminated single-quoted scalar');
    return value.slice(1, -1).replace(/''/g, "'");
  }

  let quote = null;
  const stack = [];
  const pairs = { '[': ']', '{': '}' };
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (pairs[char]) {
      stack.push(pairs[char]);
    } else if (char === ']' || char === '}') {
      if (stack.pop() !== char) throw new Error(`unmatched "${char}"`);
    }
  }
  if (quote) throw new Error('unterminated quoted scalar');
  if (stack.length > 0) throw new Error(`unterminated "${stack[stack.length - 1]}" collection`);

  if (value === 'null' || value === '~') return null;
  if (value === '[]') return [];
  if (value === '{}') return {};
  return value;
}

/**
 * Parse SKILL.md front matter as YAML and retain source key order for the
 * contract's declared-order checks.
 */
function parseFrontMatter(rawFrontMatter) {
  const value = yaml.load(rawFrontMatter);
  const isMapping = value !== null && typeof value === 'object' && !Array.isArray(value);
  const topLevelKeys = isMapping ? Object.keys(value) : [];
  const metadata = isMapping ? value.metadata : null;
  const metadataKeys = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? Object.keys(metadata)
    : [];

  return { value, topLevelKeys, metadataKeys };
}

function parseNonEmptyYamlList(content) {
  const meaningful = content.split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));
  if (meaningful.length === 0 || meaningful[0] === '[]') return [];
  if (!meaningful[0].startsWith('-')) {
    throw new Error('top-level YAML value must be a list');
  }
  parseYamlScalar(meaningful[0].slice(1));
  return meaningful;
}

function parsePromptfooTests(content) {
  const lines = content.split('\n');
  const start = lines.findIndex(line => /^tests:\s*(?:#.*)?$/.test(line));
  if (start === -1) return [];

  const tests = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (/^[^\s]/.test(line)) break;
    const entry = line.match(/^\s+-\s+(.+?)\s*$/);
    if (entry) tests.push(parseYamlScalar(entry[1]));
  }
  return tests;
}

// Coaching lemmas: phrases that prescribe how to think/write/behave generally.
// A match is only flagged when the line carries NO AKS/Azure/K8s domain token and
// NO safety verb (see checkCoaching) — so durable tool/policy/safety lines pass.
const COACHING_LEMMAS = [
  'painfully concise', 'be concise', 'be thorough', 'step by step', 'step-by-step',
  'think carefully', 'think hard', 'bias towards', 'bias toward', "don't stop at",
  'do not stop at', 'always use tools', 'use tools first', 'proactively',
  'leave out', 'filler words', 'five whys', 'be brief', 'be professional',
];
// Domain tokens whose presence marks a line as durable (command/resource/error/field).
const DOMAIN_RE = /\b(az|kubectl|aks|nsg|cni|vnet|nodepool|kubelet|coredns|nvidia|gpu|dcgm|kaito|mcp|pvc|pdb|snat|vm|nic|udr|helm|tcpdump|bpf)\b|networkProfile|nvidia\.com|mcr\.microsoft|error code|`[^`]+`/i;
const SAFETY_RE = /\b(delete|drain|cordon|scale|restart|upgrade|reconfigure|read-only|readonly|do not|never)\b/i;

/**
 * Find all skill folders (directories containing SKILL.md anywhere in the tree).
 */
function findSkillFolders(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    const hasSkillMd = entries.some(e => e.isFile() && e.name === 'SKILL.md');
    if (hasSkillMd) {
      results.push(current);
      // Keep recursing: a skill's own references/ and scripts/ subfolders hold no
      // SKILL.md, so they are never double-counted, and any genuinely nested skill
      // must still be discovered rather than silently skipped.
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        walk(path.join(current, entry.name));
      }
    }
  }

  walk(dir);
  return results;
}

function findMarkdownFiles(target) {
  if (!fs.existsSync(target)) return [];

  const stat = fs.statSync(target);
  if (stat.isFile()) return target.endsWith('.md') ? [target] : [];

  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) return findMarkdownFiles(child);
    return entry.isFile() && entry.name.endsWith('.md') ? [child] : [];
  });
}

function checkAzureMcpGuidanceContract(skillsDir, addError) {
  const repoRoot = path.dirname(skillsDir);
  const manifestPaths = [
    path.join(repoRoot, '.mcp.json'),
    path.join(repoRoot, 'plugin.json'),
    path.join(repoRoot, '.claude-plugin', 'plugin.json'),
    path.join(repoRoot, '.claude-plugin', 'marketplace.json'),
  ].filter(filePath => fs.existsSync(filePath));
  const guidanceFiles = [
    ...findMarkdownFiles(path.join(repoRoot, 'README.md')),
    ...findMarkdownFiles(path.join(repoRoot, 'docs')),
    ...findMarkdownFiles(skillsDir),
    ...manifestPaths,
  ];
  const readinessRoot = path.join(skillsDir, 'aks-automatic-readiness');

  for (const filePath of guidanceFiles) {
    const content = readText(filePath);
    const hardcodedName = content.match(HARDCODED_AZURE_MCP_NAME_RE);
    if (hardcodedName) {
      addError(
        filePath,
        `hardcoded Azure MCP tool name "${hardcodedName[0]}" is host-assigned; use capability discovery instead`,
      );
    }

    for (const [index, line] of content.split('\n').entries()) {
      if (AKS_MCP_PRODUCT_NAME_RE.test(line) && !EXPLICIT_AKS_MCP_PRODUCT_RE.test(line)) {
        addError(
          filePath,
          `line ${index + 1} uses "AKS MCP" without naming the separate Azure/aks-mcp product; call @azure/mcp "Azure MCP Server"`,
        );
      }
    }

    const isReadinessGuidance = filePath === readinessRoot
      || filePath.startsWith(`${readinessRoot}${path.sep}`)
      || /\b(?:AKS Automatic|readiness assessment|readiness API)\b/i.test(content);
    if (isReadinessGuidance) {
      for (const { label, pattern } of REMOVED_READINESS_API_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
          addError(
            filePath,
            `${label} "${match[0]}" belongs to the removed fictional MCP readiness API; collect sanitized evidence and evaluate it locally`,
          );
        }
      }
    }
  }
}

/**
 * Extract the raw YAML front matter block (text between the --- delimiters).
 * Returns null if the file has no recognizable front matter block at all —
 * This only detects the boundaries; parseFrontMatter() parses the extracted
 * block with js-yaml.
 */
function extractFrontMatterBlock(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return match ? match[1] : null;
}

/**
 * Order-check helper: given the keys as they actually appear in the parsed
 * document and a contract-declared required order, verify that whichever of
 * the required keys ARE present appear in the declared relative order.
 * Keys that are missing entirely are reported by the required-field check,
 * not here, so the two checks never double-report the same defect.
 */
function checkDeclaredOrder(actualKeys, requiredOrder) {
  const present = actualKeys.filter(k => requiredOrder.includes(k));
  const expected = requiredOrder.filter(k => present.includes(k));
  if (present.join(',') === expected.join(',')) return null;
  return { found: present, expected };
}

function isScriptShaped(filePath, firstLine) {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '' || SCRIPT_EXTENSIONS.has(extension) || firstLine.startsWith('#!');
}

/**
 * Read the executable mode from Git's index, which is stable across filesystems
 * and platforms. A null mode means the index cannot authoritatively answer.
 */
function readGitIndexMode(filePath, gitCommand) {
  const options = { encoding: 'utf8', windowsHide: true };
  const rootResult = spawnSync(
    gitCommand,
    ['-C', path.dirname(filePath), 'rev-parse', '--show-toplevel'],
    options,
  );

  if (rootResult.error) {
    const reason = rootResult.error.code === 'ENOENT'
      ? 'Git executable is unavailable'
      : `Git could not be executed: ${rootResult.error.message}`;
    return { mode: null, reason };
  }
  if (rootResult.status !== 0) {
    return { mode: null, reason: 'file is not inside a Git work tree' };
  }

  const repoRoot = fs.realpathSync(rootResult.stdout.trim());
  const nativeRelativePath = path.relative(repoRoot, fs.realpathSync(filePath));
  if (nativeRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(nativeRelativePath)) {
    return { mode: null, reason: 'file is outside the discovered Git work tree' };
  }
  const relativePath = nativeRelativePath.split(path.sep).join('/');

  const indexResult = spawnSync(
    gitCommand,
    ['-C', repoRoot, 'ls-files', '--stage', '--', relativePath],
    options,
  );
  if (indexResult.error) {
    return { mode: null, reason: `Git index could not be read: ${indexResult.error.message}` };
  }
  if (indexResult.status !== 0) {
    return { mode: null, reason: 'Git index could not be read' };
  }

  const entry = indexResult.stdout.match(/^(\d{6}) [0-9a-f]+ 0\t/);
  if (!entry) {
    return { mode: null, reason: 'file is untracked or has no stage-0 index entry' };
  }
  return { mode: entry[1], reason: null };
}

/**
 * Run the full contract lint against a skills directory.
 * Returns { errors, warnings, skillCount } — does not print or exit, so it
 * can be called in-process by tests against fixture directories.
 */
function lintSkills({
  skillsDir,
  testsDir,
  promptfooConfigPath,
  providersDir = null,
  gitCommand = 'git',
}) {
  const errors = [];
  const warnings = [];
  let skillCount = 0;

  function addError(skillPath, msg) {
    errors.push(`ERROR [${path.relative(skillsDir, skillPath)}]: ${msg}`);
  }
  function addWarning(skillPath, msg) {
    warnings.push(`WARN  [${path.relative(skillsDir, skillPath)}]: ${msg}`);
  }

  if (providersDir !== null) {
    errors.push(...lintProviderContracts({
      providersDir,
      repoRoot: path.dirname(skillsDir),
    }));
  }

  const vocabularyDir = providersDir || DEFAULT_PROVIDERS_DIR;
  let knownCapabilityIds = new Set();
  let requirementModes = new Set();
  let providerToolNames = new Set();
  try {
    const vocabulary = loadCapabilityVocabulary(vocabularyDir);
    knownCapabilityIds = vocabulary.capabilityIds;
    requirementModes = vocabulary.requirementModes;
    providerToolNames = loadProviderOperationNames(vocabularyDir);
  } catch (error) {
    errors.push(`ERROR [providers]: cannot load capability vocabulary: ${error.message}`);
  }

  // Load evals/promptfooconfig.yaml once so every skill's quality-tests.yaml
  // wiring can be checked against it (contract §5 "wired into promptfooconfig.yaml").
  let promptfooTests = null; // null = could not read/parse; array = tests: list
  if (fs.existsSync(promptfooConfigPath)) {
    try {
      promptfooTests = parsePromptfooTests(readText(promptfooConfigPath));
    } catch (e) {
      addError(promptfooConfigPath, `could not parse promptfooconfig.yaml as YAML: ${e.message}`);
    }
  } else {
    addError(promptfooConfigPath, 'promptfooconfig.yaml not found — cannot verify quality-test wiring (contract §5)');
  }

  /**
   * Every shipped skill must have non-empty trigger-tests.yaml AND
   * quality-tests.yaml (contract §5). "Non-empty" means it parses to a YAML
   * list with at least one test case, not merely a non-empty file.
   */
  function checkYamlListFile(filePath, skillMdPath, label) {
    if (!fs.existsSync(filePath)) {
      addError(skillMdPath, `missing required evals/tests/.../${label} (contract §5)`);
      return false;
    }
    let parsed;
    try {
      parsed = parseNonEmptyYamlList(readText(filePath));
    } catch (e) {
      addError(skillMdPath, `${label} is not valid YAML: ${e.message}`);
      return false;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      addError(skillMdPath, `${label} must be a non-empty list of test cases (contract §5)`);
      return false;
    }
    return true;
  }

  function checkTestCoverage(skillName, skillMdPath) {
    const triggerPath = path.join(testsDir, skillName, 'trigger-tests.yaml');
    const qualityPath = path.join(testsDir, skillName, 'quality-tests.yaml');
    checkYamlListFile(triggerPath, skillMdPath, 'trigger-tests.yaml');
    const qualityOk = checkYamlListFile(qualityPath, skillMdPath, 'quality-tests.yaml');

    if (!qualityOk) return; // already errored above; don't pile on a wiring error too

    if (promptfooTests === null) return; // config itself unreadable; already errored once

    const expectedEntry = `file://tests/${skillName}/quality-tests.yaml`;
    if (!promptfooTests.includes(expectedEntry)) {
      addError(
        skillMdPath,
        `quality-tests.yaml is not wired into evals/promptfooconfig.yaml (expected a "${expectedEntry}" entry under tests:) (contract §5)`,
      );
    }
  }

  /**
   * Check script-shaped files in a skill folder for a valid shebang and Git
   * index mode 100755 (contract §4 "Executable bit set"). The established
   * .sh/.py scope is extended to extensionless scripts and files with shebangs.
   */
  function checkScripts(skillDir) {
    const scriptsDir = path.join(skillDir, 'scripts');
    if (!fs.existsSync(scriptsDir)) return;

    const scripts = [];
    function walk(current) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
        } else if (entry.isFile()) {
          const firstLine = readText(entryPath).split('\n')[0];
          if (isScriptShaped(entryPath, firstLine)) {
            scripts.push({ filePath: entryPath, firstLine });
          }
        }
      }
    }
    walk(scriptsDir);

    for (const { filePath, firstLine } of scripts) {
      if (!VALID_SHEBANG_RE.test(firstLine)) {
        addError(filePath, 'Script missing a valid shebang line (e.g. #!/bin/bash, #!/usr/bin/env python3) (contract §4)');
      }
      const { mode, reason } = readGitIndexMode(filePath, gitCommand);
      if (mode === null) {
        addWarning(filePath, `Cannot verify script executable bit from Git index: ${reason} (contract §4)`);
      } else if (mode !== '100755') {
        addError(filePath, 'Script is not executable (git mode must be 100755 — run `chmod +x` and re-stage) (contract §4)');
      }
    }
  }

  /**
   * Check that file references in SKILL.md (backtick-quoted paths) actually exist.
   */
  function checkInternalRefs(skillDir, content) {
    // Match patterns like `scripts/foo.sh`, `references/bar.md`, `assets/baz.md`
    const refPattern = /`((?:scripts|references|assets)\/[^`]+)`/g;
    let match;
    while ((match = refPattern.exec(content)) !== null) {
      const refPath = match[1].split(' ')[0]; // handle `scripts/foo.sh <args>`
      const fullPath = path.join(skillDir, refPath);
      if (!fs.existsSync(fullPath)) {
        addError(path.join(skillDir, 'SKILL.md'), `References \`${refPath}\` but file does not exist`);
      }
    }
  }

  /**
   * Coaching-phrase lint (advisory). Flags second-person coaching that fights the host
   * model's trained posture, so a reviewer can decide whether it still earns its place.
   * Never errors — durability is a judgment call, not a hard gate.
   */
  function checkCoaching(skillDir, content) {
    const body = content.replace(/^---\n[\s\S]*?\n---/, ''); // skip front matter
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();
      const lemma = COACHING_LEMMAS.find(l => lower.includes(l));
      if (!lemma) continue;
      if (DOMAIN_RE.test(line) || SAFETY_RE.test(line)) continue; // durable — tool/policy/safety
      addWarning(path.join(skillDir, 'SKILL.md'),
        `coaching phrase "${lemma}" (durability: does this fight the host model's default posture? drop unless it encodes a policy/tool/safety rule)`);
    }
  }

  // --- Main per-skill loop ---

  checkAzureMcpGuidanceContract(skillsDir, addError);
  const skillFolders = findSkillFolders(skillsDir);

  for (const skillDir of skillFolders) {
    skillCount++;
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const folderName = path.basename(skillDir);

    const content = readText(skillMdPath);
    const rawFrontMatter = extractFrontMatterBlock(content);

    if (rawFrontMatter === null) {
      addError(skillMdPath, 'Missing or malformed YAML front matter (must start with --- and end with ---)');
      continue;
    }

    let fm;
    let topLevelKeys;
    let metadataKeys;
    try {
      const parsed = parseFrontMatter(rawFrontMatter);
      fm = parsed.value;
      topLevelKeys = parsed.topLevelKeys;
      metadataKeys = parsed.metadataKeys;
    } catch (e) {
      addError(skillMdPath, `Front matter is not valid YAML: ${e.message}`);
      continue;
    }

    if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
      addError(skillMdPath, 'Front matter must be a YAML mapping (object)');
      continue;
    }

    // --- Required fields, present ---
    const hasField = f => Object.prototype.hasOwnProperty.call(fm, f)
      && fm[f] !== null && fm[f] !== undefined && fm[f] !== '';

    for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
      if (!hasField(field)) {
        addError(skillMdPath, `Missing required field: ${field}`);
      }
    }

    const hasMetadataObject = hasField('metadata') && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata);
    if (hasField('metadata') && !hasMetadataObject) {
      addError(skillMdPath, 'metadata must be a YAML mapping (object)');
    }

    if (hasMetadataObject) {
      const hasMetaField = f => Object.prototype.hasOwnProperty.call(fm.metadata, f)
        && fm.metadata[f] !== null && fm.metadata[f] !== undefined && fm.metadata[f] !== '';
      if (!hasMetaField('author')) addError(skillMdPath, 'Missing required field: metadata.author');
      if (!hasMetaField('version')) addError(skillMdPath, 'Missing required field: metadata.version');
      if (!Object.prototype.hasOwnProperty.call(fm.metadata, 'capabilities')) {
        addError(skillMdPath, 'Missing required field: metadata.capabilities');
      }
    }

    // --- Declared ordering (contract §2) ---
    const topOrder = checkDeclaredOrder(topLevelKeys, REQUIRED_TOP_LEVEL_ORDER);
    if (topOrder) {
      addError(
        skillMdPath,
        `front matter fields out of declared order: found [${topOrder.found.join(', ')}], contract requires [${topOrder.expected.join(', ')}]`,
      );
    }
    if (hasMetadataObject) {
      const metaOrder = checkDeclaredOrder(metadataKeys, REQUIRED_METADATA_ORDER);
      if (metaOrder) {
        addError(
          skillMdPath,
          `metadata fields out of declared order: found [${metaOrder.found.join(', ')}], contract requires [${metaOrder.expected.join(', ')}]`,
        );
      }
    }

    // --- name === folder (error, not a warning — the contract states this as a MUST) ---
    if (hasField('name') && fm.name !== folderName) {
      addError(skillMdPath, `front matter name "${fm.name}" must equal folder name "${folderName}"`);
    }

    // --- license / author exact values (contract §2) ---
    if (hasField('license') && fm.license !== EXPECTED_LICENSE) {
      addError(skillMdPath, `license "${fm.license}" must be "${EXPECTED_LICENSE}" (contract §2)`);
    }
    if (hasMetadataObject && Object.prototype.hasOwnProperty.call(fm.metadata, 'author')
      && fm.metadata.author !== EXPECTED_AUTHOR) {
      addError(skillMdPath, `metadata.author "${fm.metadata.author}" must be "${EXPECTED_AUTHOR}" (contract §2)`);
    }

    // --- version semver (contract §2) ---
    if (hasMetadataObject && Object.prototype.hasOwnProperty.call(fm.metadata, 'version')
      && fm.metadata.version !== null && fm.metadata.version !== undefined) {
      const v = String(fm.metadata.version);
      if (!SEMVER_RE.test(v)) {
        addError(skillMdPath, `metadata.version "${v}" is not valid semver (expected "X.Y.Z") (contract §2)`);
      }
    }

    // --- Provider-neutral capability requirements (contract §2) ---
    if (hasMetadataObject && Object.prototype.hasOwnProperty.call(fm.metadata, 'capabilities')) {
      const capabilities = fm.metadata.capabilities;
      if (!Array.isArray(capabilities)) {
        addError(skillMdPath, 'metadata.capabilities must be a YAML list');
      } else {
        const seenCapabilityIds = new Set();
        for (const [index, capability] of capabilities.entries()) {
          const location = `metadata.capabilities[${index}]`;
          if (!isMapping(capability)) {
            addError(skillMdPath, `${location} must be a YAML mapping with id and mode`);
            continue;
          }

          const allowedKeys = capability.mode === 'conditional'
            ? ['id', 'mode', 'when']
            : ['id', 'mode'];
          const extraKeys = Object.keys(capability).filter(key => !allowedKeys.includes(key));
          if (extraKeys.length > 0) {
            addError(
              skillMdPath,
              `${location} contains non-canonical field(s): ${extraKeys.join(', ')}; use only id, mode, and conditional when`,
            );
          }
          if (!knownCapabilityIds.has(capability.id)) {
            addError(skillMdPath, `${location}.id "${capability.id}" is not a known semantic capability`);
          }
          if (!requirementModes.has(capability.mode)) {
            addError(skillMdPath, `${location}.mode "${capability.mode}" is not a valid requirement mode`);
          }
          if (seenCapabilityIds.has(capability.id)) {
            addError(skillMdPath, `${location}.id "${capability.id}" is duplicated`);
          }
          seenCapabilityIds.add(capability.id);

          if (
            capability.mode === 'conditional'
            && (typeof capability.when !== 'string' || capability.when.trim() === '')
          ) {
            addError(skillMdPath, `${location}.when is required for conditional capabilities`);
          }
          for (const value of Object.values(capability)) {
            if (typeof value !== 'string') continue;
            const alias = value.match(HOST_ALIAS_RE);
            if (alias) {
              addError(skillMdPath, `${location} contains forbidden host alias "${alias[0]}"`);
            }
            const toolName = [...providerToolNames].find(name => value.includes(name));
            if (toolName) {
              addError(skillMdPath, `${location} contains provider-specific tool name "${toolName}"`);
            }
          }
        }
      }
    }

    // --- description content rules (contract §2) ---
    if (hasField('description')) {
      if (typeof fm.description !== 'string') {
        addError(skillMdPath, 'description must be a string');
      } else {
        const desc = fm.description;

        if (desc.length > MAX_DESCRIPTION_CHARS) {
          addError(
            skillMdPath,
            `description is ${desc.length} chars, exceeds the contract's routing budget of ~${MAX_DESCRIPTION_CHARS} chars (contract §2 "Budget")`,
          );
        }

        if (!/\bWHEN:/.test(desc)) {
          addError(skillMdPath, 'description missing required "WHEN:" trigger clause (contract §2)');
        }

        const dnuIndex = desc.search(/\bDO NOT USE FOR:/);
        if (dnuIndex === -1) {
          addError(skillMdPath, 'description missing required "DO NOT USE FOR:" boundary clause (contract §2)');
        } else {
          const tail = desc.slice(dnuIndex);
          if (!/\((?:use|see)\s+[^)]+\)/i.test(tail)) {
            addError(
              skillMdPath,
              'description "DO NOT USE FOR:" clause must name a sibling skill via the parenthetical-redirect grammar, e.g. "(use <skill>)" or "(see <skill>)" (contract §2)',
            );
          }
        }

        if (desc.split(/\s+/).filter(Boolean).length < 5) {
          addWarning(skillMdPath, 'Description is very short (< 5 words) — may not trigger well in skill routing');
        }
      }
    }

    // Scripts
    checkScripts(skillDir);

    // Internal references
    checkInternalRefs(skillDir, content);

    // Eval coverage (error if a skill is missing or has empty trigger/quality tests,
    // or a quality-tests.yaml that isn't wired into promptfooconfig.yaml)
    checkTestCoverage(folderName, skillMdPath);

    // Durability: coaching-phrase lint (warning only)
    checkCoaching(skillDir, content);
  }

  return { errors, warnings, skillCount };
}

// --- CLI entry point ---

if (require.main === module) {
  const SKILLS_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'skills'));
  const TESTS_DIR = path.resolve(process.env.LINT_TESTS_DIR || path.join(__dirname, 'tests'));
  const PROMPTFOO_CONFIG = path.resolve(process.env.LINT_PROMPTFOO_CONFIG || path.join(__dirname, 'promptfooconfig.yaml'));
  const PROVIDERS_DIR = path.resolve(process.env.LINT_PROVIDERS_DIR || path.join(__dirname, '..', 'providers'));

  const { errors, warnings, skillCount } = lintSkills({
    skillsDir: SKILLS_DIR,
    testsDir: TESTS_DIR,
    promptfooConfigPath: PROMPTFOO_CONFIG,
    providersDir: PROVIDERS_DIR,
  });

  if (skillCount === 0) {
    console.error(`No skills found in ${SKILLS_DIR}`);
    process.exit(1);
  }

  console.log(`\nSkill Lint: ${skillCount} skill(s) checked\n`);

  if (warnings.length > 0) {
    console.log('Warnings:');
    warnings.forEach(w => console.log(`  ${w}`));
    console.log('');
  }

  if (errors.length > 0) {
    console.log('Errors:');
    errors.forEach(e => console.log(`  ${e}`));
    console.log(`\n✗ ${errors.length} error(s) found`);
    process.exit(1);
  } else {
    console.log('✓ All skills pass schema validation');
    process.exit(0);
  }
}

module.exports = {
  lintSkills,
  findSkillFolders,
  extractFrontMatterBlock,
  checkDeclaredOrder,
  EXPECTED_LICENSE,
  EXPECTED_AUTHOR,
  MAX_DESCRIPTION_CHARS,
  SEMVER_RE,
  REQUIRED_TOP_LEVEL_ORDER,
  REQUIRED_METADATA_ORDER,
  VALID_REQUIREMENT_MODES,
  PINNED_PROVIDER_PROVENANCE,
  lintProviderContracts,
};
