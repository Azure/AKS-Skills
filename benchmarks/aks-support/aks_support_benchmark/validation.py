"""Artifact-derived integrity and countability gates."""

from __future__ import annotations

from typing import Any


GATE_NAMES = (
    "schema_integrity",
    "contamination_clear",
    "capability_equivalent",
    "fixture_verifier_integrity",
    "prohibited_actions_clear",
    "tools_matched",
    "trace_available",
    "infrastructure_healthy",
)


def evaluate_gates(
    artifacts: dict[str, Any],
    skill_observation: dict[str, Any],
) -> dict[str, Any]:
    required = {
        "schema_valid",
        "exposed_paths",
        "expected_capability_hash",
        "actual_capability_hash",
        "fixture_hash_valid",
        "verifier_hash_valid",
        "prohibited_actions",
        "requested_tools",
        "matched_tools",
        "infrastructure_failure",
    }
    unknown = set(artifacts) - required
    missing = required - set(artifacts)
    if unknown or missing:
        raise ValueError(
            f"gate artifacts fields mismatch; missing={sorted(missing)}, unknown={sorted(unknown)}"
        )
    requested = set(artifacts["requested_tools"])
    matched = set(artifacts["matched_tools"])
    gates = {
        "schema_integrity": artifacts["schema_valid"] is True,
        "contamination_clear": not artifacts["exposed_paths"],
        "capability_equivalent": (
            artifacts["expected_capability_hash"]
            == artifacts["actual_capability_hash"]
        ),
        "fixture_verifier_integrity": (
            artifacts["fixture_hash_valid"] is True
            and artifacts["verifier_hash_valid"] is True
        ),
        "prohibited_actions_clear": not artifacts["prohibited_actions"],
        "tools_matched": requested == matched,
        "trace_available": skill_observation.get("trace_available") is True,
        "infrastructure_healthy": artifacts["infrastructure_failure"] is False,
    }
    reasons = [name for name in GATE_NAMES if not gates[name]]
    infrastructure_only = reasons == ["infrastructure_healthy"]
    status = (
        "countable"
        if not reasons
        else "uncountable"
        if infrastructure_only
        else "non-attributable"
    )
    return {"status": status, "gates": gates, "reasons": reasons}


def validate_pairing(
    skill_manifest: dict[str, Any], no_skill_manifest: dict[str, Any]
) -> None:
    constant_fields = {
        "pair_id",
        "mode",
        "repetition",
        "seed",
        "capability_profile",
        "budgets",
        "retry_policy",
    }
    for field in constant_fields:
        if skill_manifest.get(field) != no_skill_manifest.get(field):
            raise ValueError(f"paired cohort mismatch: {field}")
    left_identities = dict(skill_manifest.get("identities", {}))
    right_identities = dict(no_skill_manifest.get("identities", {}))
    left_skill = left_identities.pop("skill", None)
    right_skill = right_identities.pop("skill", None)
    if left_identities != right_identities:
        raise ValueError("paired cohort mismatch: immutable identities")
    if skill_manifest.get("skill_available") is not True:
        raise ValueError("skill arm must have skill_available=true")
    if no_skill_manifest.get("skill_available") is not False:
        raise ValueError("no-skill arm must have skill_available=false")
    if left_skill == right_skill:
        raise ValueError("paired arms must differ in skill identity")
