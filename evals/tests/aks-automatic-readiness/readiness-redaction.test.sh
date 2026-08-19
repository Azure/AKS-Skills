#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FILTER="$REPO_ROOT/skills/aks-automatic-readiness/scripts/sanitize-readiness-input.jq"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for CLI-host readiness redaction" >&2
  exit 1
fi
jq --version >/dev/null

INPUT="$(cat <<'JSON'
{
  "apiVersion": "v1",
  "kind": "List",
  "items": [
    {
      "apiVersion": "apps/v1",
      "kind": "Deployment",
      "metadata": {
        "name": "payments",
        "namespace": "prod",
        "labels": {
          "app": "payments",
          "kubernetes.azure.com/agentpool": "system",
          "internal.example/token": "LABEL_SENTINEL"
        },
        "managedFields": [
          {"manager": "MANAGED_FIELDS_SENTINEL"}
        ]
      },
      "spec": {
        "replicas": 3,
        "selector": {"matchLabels": {"app": "payments"}},
        "template": {
          "metadata": {
            "labels": {"app": "payments"},
            "annotations": {
              "container.apparmor.security.beta.kubernetes.io/web": "runtime/default",
              "sensitive.example/token": "ANNOTATION_SENTINEL",
              "example.com/apparmor-token": "APPARMOR_NEAR_MATCH_SENTINEL",
              "container.apparmor.security.beta.kubernetes.io/invalid": "APPARMOR_VALUE_SENTINEL"
            }
          },
          "spec": {
            "hostNetwork": true,
            "affinity": {
              "podAntiAffinity": {
                "preferredDuringSchedulingIgnoredDuringExecution": []
              }
            },
            "containers": [
              {
                "name": "web",
                "image": "registry.example/payments:v1",
                "env": [
                  {"name": "TOKEN", "value": "ENV_SENTINEL"},
                  {
                    "name": "PASSWORD",
                    "valueFrom": {
                      "secretKeyRef": {
                        "name": "ENV_SECRET_REF_SENTINEL",
                        "key": "password"
                      }
                    }
                  }
                ],
                "args": ["--token=ARG_SENTINEL"],
                "resources": {
                  "requests": {"cpu": "100m", "memory": "128Mi"},
                  "limits": {"cpu": "500m", "memory": "512Mi"}
                },
                "readinessProbe": {
                  "httpGet": {
                    "path": "/ready",
                    "httpHeaders": [
                      {"name": "Authorization", "value": "HEADER_SENTINEL"}
                    ]
                  }
                },
                "securityContext": {
                  "privileged": false,
                  "allowPrivilegeEscalation": false
                },
                "ports": [{"containerPort": 8080, "hostPort": 8080}]
              }
            ],
            "volumes": [
              {
                "name": "secrets-store",
                "csi": {
                  "driver": "secrets-store.csi.k8s.io",
                  "nodeStageSecretRef": {
                    "name": "NODE_STAGE_SENTINEL",
                    "namespace": "prod"
                  },
                  "volumeAttributes": {"secretProviderClass": "CSI_SENTINEL"}
                }
              }
            ]
          }
        }
      }
    },
    {
      "apiVersion": "apps/v1",
      "kind": "StatefulSet",
      "metadata": {"name": "ledger", "namespace": "prod"},
      "spec": {
        "replicas": 2,
        "template": {
          "metadata": {"labels": {"app": "ledger"}},
          "spec": {
            "containers": [
              {"name": "ledger", "image": "registry.example/ledger:v1"}
            ]
          }
        }
      }
    },
    {
      "apiVersion": "apps/v1",
      "kind": "DaemonSet",
      "metadata": {"name": "telemetry", "namespace": "prod"},
      "spec": {
        "template": {
          "metadata": {"labels": {"app": "telemetry"}},
          "spec": {
            "containers": [
              {"name": "agent", "image": "registry.example/agent:v1"}
            ]
          }
        }
      }
    },
    {
      "apiVersion": "batch/v1",
      "kind": "Job",
      "metadata": {"name": "migration", "namespace": "prod"},
      "spec": {
        "template": {
          "metadata": {"labels": {"app": "migration"}},
          "spec": {
            "containers": [
              {"name": "migration", "image": "registry.example/migration:v1"}
            ]
          }
        }
      }
    },
    {
      "apiVersion": "batch/v1",
      "kind": "CronJob",
      "metadata": {"name": "nightly", "namespace": "prod"},
      "spec": {
        "jobTemplate": {
          "spec": {
            "template": {
              "metadata": {"labels": {"app": "nightly"}},
              "spec": {
                "containers": [
                  {"name": "nightly", "image": "registry.example/nightly:v1"}
                ]
              }
            }
          }
        }
      }
    },
    {
      "apiVersion": "v1",
      "kind": "Pod",
      "metadata": {"name": "standalone", "namespace": "prod"},
      "spec": {
        "hostPID": true,
        "containers": [
          {
            "name": "unsafe",
            "image": "registry.example/unsafe:latest",
            "securityContext": {"privileged": true}
          },
          {"name": "untagged", "image": "registry.example:5000/untagged"},
          {
            "name": "digest",
            "image": "registry.example/digest@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        ]
      }
    },
    {
      "apiVersion": "v1",
      "kind": "Service",
      "metadata": {"name": "payments", "namespace": "prod"},
      "spec": {
        "selector": {"app": "SELECTOR_SENTINEL"},
        "ports": [{"port": 443}]
      }
    },
    {
      "apiVersion": "v1",
      "kind": "Service",
      "metadata": {"name": "payments-alias", "namespace": "prod"},
      "spec": {
        "selector": {"app": "SELECTOR_SENTINEL"},
        "ports": [{"port": 80}]
      }
    },
    {
      "apiVersion": "v1",
      "kind": "Service",
      "metadata": {"name": "external", "namespace": "prod"},
      "spec": {"type": "ExternalName", "externalName": "example.com"}
    },
    {
      "apiVersion": "policy/v1",
      "kind": "PodDisruptionBudget",
      "metadata": {"name": "payments", "namespace": "prod"},
      "spec": {
        "minAvailable": 1,
        "selector": {"matchLabels": {"app": "PDB_SELECTOR_SENTINEL"}}
      }
    },
    {
      "apiVersion": "storage.k8s.io/v1",
      "kind": "StorageClass",
      "metadata": {"name": "managed-csi"},
      "provisioner": "disk.csi.azure.com",
      "parameters": {
        "csi.storage.k8s.io/provisioner-secret-name": "SC_SECRET_SENTINEL",
        "csi.storage.k8s.io/provisioner-secret-namespace": "prod"
      }
    },
    {
      "apiVersion": "v1",
      "kind": "Secret",
      "metadata": {
        "name": "SECRET_NAME_SENTINEL",
        "namespace": "SECRET_NAMESPACE_SENTINEL"
      },
      "data": {"token": "SECRET_VALUE_SENTINEL"},
      "stringData": {"password": "SECRET_PASSWORD_SENTINEL"}
    },
    {
      "apiVersion": "v1",
      "kind": "ConfigMap",
      "metadata": {
        "name": "CONFIGMAP_NAME_SENTINEL",
        "namespace": "CONFIGMAP_NAMESPACE_SENTINEL"
      },
      "data": {"settings": "CONFIGMAP_VALUE_SENTINEL"}
    },
    {
      "apiVersion": "apiextensions.k8s.io/v1",
      "kind": "CustomResourceDefinition",
      "metadata": {"name": "CRD_NAME_SENTINEL"},
      "spec": {"group": "CRD_GROUP_SENTINEL"}
    },
    {
      "apiVersion": "databases.example.com/v1",
      "kind": "DatabaseCluster",
      "metadata": {
        "name": "CUSTOM_RESOURCE_NAME_SENTINEL",
        "namespace": "CUSTOM_RESOURCE_NAMESPACE_SENTINEL"
      },
      "spec": {"adminPassword": "CUSTOM_RESOURCE_SECRET_SENTINEL"}
    }
  ]
}
JSON
)"

OUTPUT="$(printf '%s' "$INPUT" | jq -c -f "$FILTER")"

assert_json() {
  local description="$1"
  local expression="$2"
  if ! printf '%s' "$OUTPUT" | jq -e "$expression" >/dev/null; then
    echo "FAIL: $description" >&2
    printf '%s' "$OUTPUT" | jq . >&2
    exit 1
  fi
  echo "ok: $description"
}

assert_absent() {
  local sentinel="$1"
  if [[ "$OUTPUT" == *"$sentinel"* ]]; then
    echo "FAIL: output retained $sentinel" >&2
    exit 1
  fi
}

for sentinel in \
  ANNOTATION_SENTINEL \
  APPARMOR_NEAR_MATCH_SENTINEL \
  APPARMOR_VALUE_SENTINEL \
  LABEL_SENTINEL \
  MANAGED_FIELDS_SENTINEL \
  SELECTOR_SENTINEL \
  PDB_SELECTOR_SENTINEL \
  ENV_SENTINEL \
  ENV_SECRET_REF_SENTINEL \
  ARG_SENTINEL \
  HEADER_SENTINEL \
  NODE_STAGE_SENTINEL \
  CSI_SENTINEL \
  SC_SECRET_SENTINEL \
  SECRET_NAME_SENTINEL \
  SECRET_NAMESPACE_SENTINEL \
  SECRET_VALUE_SENTINEL \
  SECRET_PASSWORD_SENTINEL \
  CONFIGMAP_NAME_SENTINEL \
  CONFIGMAP_NAMESPACE_SENTINEL \
  CONFIGMAP_VALUE_SENTINEL \
  CRD_NAME_SENTINEL \
  CRD_GROUP_SENTINEL \
  CUSTOM_RESOURCE_NAME_SENTINEL \
  CUSTOM_RESOURCE_NAMESPACE_SENTINEL \
  CUSTOM_RESOURCE_SECRET_SENTINEL
do
  assert_absent "$sentinel"
done
echo "ok: sensitive values and unsupported-object identifiers are absent"

assert_json \
  "Deployment projection retains assessment fields" \
  '(.items[] | select(.kind == "Deployment")) as $d
   | ($d.metadata.restrictedLabelKeys == ["kubernetes.azure.com/agentpool"])
   and ($d.spec.template.spec.hostNetwork == true)
   and ($d.spec.template.spec.podAntiAffinityConfigured == true)
   and ($d.spec.template.spec.containers[0].imagePolicy == {
     "usesLatestTag": false,
     "pinned": true
   })
   and ($d.spec.template.spec.containers[0].readinessProbeConfigured == true)
   and ($d.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation == false)
   and ($d.spec.template.spec.containers[0].ports[0].hostPort == 8080)
   and ($d.spec.template.spec.volumes[0].types == ["csi"])
   and ($d.spec.template.metadata.legacyAppArmorProfiles == [
     {"container": "web", "valid": true},
     {"container": "invalid", "valid": false}
   ])'

for kind in StatefulSet DaemonSet Job; do
  assert_json \
    "$kind remains a supported workload projection" \
    "any(.items[]; .kind == \"$kind\"
      and .spec.template.spec.containers[0].imagePolicy.pinned == true)"
done

assert_json \
  "CronJob remains a supported workload projection" \
  '(.items[] | select(.kind == "CronJob"))
   | .spec.jobTemplate.spec.template.spec.containers[0].imagePolicy.pinned == true'

assert_json \
  "Pod image policy preserves latest, tag, and digest behavior" \
  '(.items[] | select(.kind == "Pod")) as $p
   | ($p.spec.hostPID == true)
   and ($p.spec.containers[0].securityContext.privileged == true)
   and ($p.spec.containers[0].imagePolicy == {
     "usesLatestTag": true,
     "pinned": false
   })
   and ($p.spec.containers[1].imagePolicy == {
     "usesLatestTag": true,
     "pinned": false
   })
   and ($p.spec.containers[2].imagePolicy == {
     "usesLatestTag": false,
     "pinned": true
   })'

assert_json \
  "Service duplicate counts remain available without selector values" \
  '[.items[] | select(.kind == "Service") | .selectorDuplicateCount] == [2, 2, 0]'

assert_json \
  "PodDisruptionBudget projection retains availability without selectors" \
  '(.items[] | select(.kind == "PodDisruptionBudget")) as $pdb
   | ($pdb.spec.minAvailable == 1)
     and ($pdb.spec | has("selector") | not)'

assert_json \
  "StorageClass projection retains the provisioner without parameters" \
  '(.items[] | select(.kind == "StorageClass"))
   | .provisioner == "disk.csi.azure.com"
     and (has("parameters") | not)'

assert_json \
  "unsupported Kubernetes kinds are dropped" \
  '[.items[].kind]
   | (index("Secret") == null)
     and (index("ConfigMap") == null)
     and (index("CustomResourceDefinition") == null)
     and (index("DatabaseCluster") == null)'

set +e
bash -c 'printf "%s" "{\"apiVersion\":\"v1\",\"kind\":\"List\",\"items\":[]}"; exit 17' \
  | jq -f "$FILTER" >/dev/null
pipeline_status=$?
set -e
if [[ "$pipeline_status" -ne 17 ]]; then
  echo "FAIL: upstream Kubernetes read failure was masked (status $pipeline_status)" >&2
  exit 1
fi
echo "ok: upstream Kubernetes read failure propagates through the redaction pipeline"

echo "All readiness redaction tests passed."
