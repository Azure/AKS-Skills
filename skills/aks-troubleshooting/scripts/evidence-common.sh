#!/usr/bin/env bash
# Shared fail-closed target, artifact, validation, and redaction helpers.

set -o pipefail

evidence_error() {
    printf 'ERROR: %s\n' "$*" >&2
}

evidence_die() {
    evidence_error "$*"
    exit 2
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || evidence_die "$1 not found on PATH"
}

validate_value() {
    local label="$1" value="$2" pattern="$3"
    [[ -n "$value" && "$value" =~ $pattern ]] \
        || evidence_die "invalid $label"
}

validate_subscription() {
    validate_value "subscription ID" "$1" '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
}

validate_resource_group() {
    validate_value "resource group" "$1" '^[A-Za-z0-9._() -]+$'
}

validate_cluster() {
    validate_value "cluster name" "$1" '^[A-Za-z0-9][A-Za-z0-9_-]*$'
}

validate_context() {
    validate_value "kube context" "$1" '^[A-Za-z0-9._:@/-]+$'
}

validate_kubernetes_name() {
    validate_value "$1" "$2" '^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$'
}

validate_container_name() {
    validate_value "container name" "$1" '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
}

validate_positive_integer() {
    validate_value "$1" "$2" '^[1-9][0-9]*$'
}

validate_kubectl_duration() {
    validate_value "$1" "$2" '^[1-9][0-9]*(ms|s|m)$'
}

validate_syscall_filter() {
    validate_value "syscall filter" "$1" '^[a-z0-9_]+(,[a-z0-9_]+)*$'
}

validate_packet_filter() {
    validate_value "packet filter" "$1" '^[A-Za-z0-9:./() _-]+$'
}

prepare_artifacts_dir() {
    local target="$1"
    [[ -n "$target" && "$target" != "/" ]] || evidence_die "invalid artifact directory"
    [[ ! -L "$target" ]] || evidence_die "artifact directory must not be a symlink"
    if [[ -e "$target" && ! -d "$target" ]]; then
        evidence_die "artifact path is not a directory"
    fi
    mkdir -p "$target"
    if find "$target" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
        evidence_die "artifact directory must be empty"
    fi
    chmod 700 "$target"
    EVIDENCE_ARTIFACTS_DIR="$(cd "$target" && pwd -P)"
    export EVIDENCE_ARTIFACTS_DIR
}

sha256_file() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print "sha256:" $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print "sha256:" $1}'
    else
        evidence_die "no SHA-256 utility is available"
    fi
}

redact_evidence() {
    awk '
      BEGIN { private_key = 0 }
      {
        lower = tolower($0)
        if (lower ~ /-----begin [a-z0-9 ]*private key-----/) {
          print "[REDACTED PRIVATE KEY BLOCK]"
          private_key = 1
          next
        }
        if (private_key) {
          if (lower ~ /-----end [a-z0-9 ]*private key-----/) private_key = 0
          next
        }

        line = $0
        lower = tolower(line)
        if (match(lower, /authorization[[:space:]]*:/)) {
          line = substr(line, 1, RSTART + RLENGTH - 1) " [REDACTED]"
        } else if (match(lower, /bearer[[:space:]]+[a-z0-9._~+\/=-]+/)) {
          line = substr(line, 1, RSTART - 1) "Bearer [REDACTED]"
        }

        lower = tolower(line)
        if (match(lower, /([a-z0-9]+[-_]key|password|passwd|pwd|token|secret|credentials?|api[-_]?key|client[-_]?secret|connection[-_]?string|sas|signature|cookie|set-cookie|accountkey|sharedaccesskey|sharedaccesssignature)"?[[:space:]]*[:=][[:space:]]*/)) {
          line = substr(line, 1, RSTART + RLENGTH - 1) "[REDACTED]"
        }

        gsub(/:\/\/[^\/[:space:]@]+:[^\/[:space:]@]+@/, "://[REDACTED]@", line)
        print line
      }
    '
}

redact_file() {
    local input="$1" output="$2"
    redact_evidence <"$input" >"$output"
    chmod 600 "$output"
}

normalize_endpoint() {
    printf '%s' "$1" \
        | tr '[:upper:]' '[:lower:]' \
        | sed -E 's#^[a-z]+://##; s#/.*$##; s#:[0-9]+$##; s/\.$//'
}

az_tsv() {
    local output
    if ! output="$(az "$@" -o tsv 2>"$EVIDENCE_ARTIFACTS_DIR/az-query-error.txt")"; then
        evidence_die "Azure target query failed"
    fi
    printf '%s' "$output"
}

verify_aks_target() {
    local subscription="$1" resource_group="$2" cluster="$3" context="$4"
    local account_id account_tenant account_type cluster_id fqdn private_fqdn
    local kube_server kube_host public_host private_host

    validate_subscription "$subscription"
    validate_resource_group "$resource_group"
    validate_cluster "$cluster"
    validate_context "$context"
    require_command az
    require_command kubectl

    if ! az account show --subscription "$subscription" -o json \
        >"$EVIDENCE_ARTIFACTS_DIR/azure-account.raw.json" \
        2>"$EVIDENCE_ARTIFACTS_DIR/azure-account.error.txt"; then
        evidence_die "Azure identity or subscription is inaccessible"
    fi
    if ! az aks show --subscription "$subscription" \
        --resource-group "$resource_group" --name "$cluster" -o json \
        >"$EVIDENCE_ARTIFACTS_DIR/aks-cluster.raw.json" \
        2>"$EVIDENCE_ARTIFACTS_DIR/aks-cluster.error.txt"; then
        evidence_die "AKS resource target is inaccessible"
    fi

    account_id="$(az_tsv account show --subscription "$subscription" --query id)"
    account_tenant="$(az_tsv account show --subscription "$subscription" --query tenantId)"
    account_type="$(az_tsv account show --subscription "$subscription" --query user.type)"
    [[ "$(printf '%s' "$account_id" | tr '[:upper:]' '[:lower:]')" \
        == "$(printf '%s' "$subscription" | tr '[:upper:]' '[:lower:]')" ]] \
        || evidence_die "Azure identity resolved a different subscription"

    cluster_id="$(az_tsv aks show --subscription "$subscription" \
        --resource-group "$resource_group" --name "$cluster" --query id)"
    fqdn="$(az_tsv aks show --subscription "$subscription" \
        --resource-group "$resource_group" --name "$cluster" --query fqdn)"
    private_fqdn="$(az_tsv aks show --subscription "$subscription" \
        --resource-group "$resource_group" --name "$cluster" --query privateFqdn)"
    [[ -n "$cluster_id" ]] || evidence_die "AKS resource ID is unknown"

    if ! kube_server="$(kubectl --context "$context" config view --minify \
        -o jsonpath='{.clusters[0].cluster.server}' \
        2>"$EVIDENCE_ARTIFACTS_DIR/kube-context.error.txt")"; then
        evidence_die "kube context is inaccessible"
    fi
    [[ -n "$kube_server" ]] || evidence_die "kube context server is unknown"

    kube_host="$(normalize_endpoint "$kube_server")"
    public_host="$(normalize_endpoint "$fqdn")"
    private_host="$(normalize_endpoint "$private_fqdn")"
    if [[ -z "$kube_host" ]] \
        || [[ "$kube_host" != "$public_host" && "$kube_host" != "$private_host" ]]; then
        evidence_die "kube context does not target the named AKS cluster"
    fi

    EVIDENCE_SUBSCRIPTION="$subscription"
    EVIDENCE_RESOURCE_GROUP="$resource_group"
    EVIDENCE_CLUSTER="$cluster"
    EVIDENCE_CONTEXT="$context"
    EVIDENCE_CLUSTER_ID="$cluster_id"
    EVIDENCE_KUBE_SERVER="$kube_server"
    EVIDENCE_TENANT_ID="$account_tenant"
    EVIDENCE_IDENTITY_TYPE="$account_type"
    export EVIDENCE_SUBSCRIPTION EVIDENCE_RESOURCE_GROUP EVIDENCE_CLUSTER
    export EVIDENCE_CONTEXT EVIDENCE_CLUSTER_ID EVIDENCE_KUBE_SERVER
    export EVIDENCE_TENANT_ID EVIDENCE_IDENTITY_TYPE

    {
        printf 'subscription=%s\n' "$EVIDENCE_SUBSCRIPTION"
        printf 'tenantId=%s\n' "$EVIDENCE_TENANT_ID"
        printf 'identityType=%s\n' "$EVIDENCE_IDENTITY_TYPE"
        printf 'resourceGroup=%s\n' "$EVIDENCE_RESOURCE_GROUP"
        printf 'cluster=%s\n' "$EVIDENCE_CLUSTER"
        printf 'clusterResourceId=%s\n' "$EVIDENCE_CLUSTER_ID"
        printf 'kubeContext=%s\n' "$EVIDENCE_CONTEXT"
        printf 'kubeServer=%s\n' "$EVIDENCE_KUBE_SERVER"
        printf 'targetProof=matched\n'
    } >"$EVIDENCE_ARTIFACTS_DIR/target.projection.txt"
    chmod 600 "$EVIDENCE_ARTIFACTS_DIR/target.projection.txt"
}

kubectl_proven() {
    kubectl --context "$EVIDENCE_CONTEXT" "$@"
}

collect_raw() {
    local name="$1"
    shift
    local path="$EVIDENCE_ARTIFACTS_DIR/$name.raw.txt"
    if "$@" >"$path" 2>&1; then
        chmod 600 "$path"
        printf '%s' "$path"
        return 0
    else
        local status=$?
        chmod 600 "$path"
        evidence_error "$name collection failed with exit $status"
        return "$status"
    fi
}

emit_artifact_record() {
    local label="$1" path="$2"
    printf '%s.path=%s\n' "$label" "$path"
    printf '%s.sha256=%s\n' "$label" "$(sha256_file "$path")"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    evidence_die "source evidence-common.sh from an evidence collector"
fi
