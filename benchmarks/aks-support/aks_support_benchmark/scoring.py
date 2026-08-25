"""Deterministic score-vector and paired-outcome derivation."""

from __future__ import annotations

from typing import Any

from .contracts import CONTRACT_VERSION, validate_contract
from .identity import sha256_value
from .validation import validate_pairing


DIMENSIONS = (
    "outcome_root_cause",
    "decisive_evidence",
    "distractor_rejection",
    "routing_escalation",
    "safe_remediation",
    "communication_uncertainty",
    "tool_efficiency",
    "infrastructure_status",
)


def score_from_verifier(
    run_id: str,
    verifier: dict[str, Any],
    artifacts: dict[str, Any],
    countability: dict[str, Any],
    qualitative: dict[str, Any] | None = None,
) -> dict[str, Any]:
    validate_contract(verifier, "verifier")
    check_ids = [check["check_id"] for check in verifier["checks"]]
    if len(check_ids) != len(set(check_ids)):
        raise ValueError("verifier contains duplicate check_id values")
    scores = {name: 0 for name in DIMENSIONS}
    dimension_results: dict[str, list[bool]] = {}
    evidence: list[dict[str, Any]] = []
    for check in verifier["checks"]:
        artifact_value = artifacts.get(check["artifact"])
        passed = artifact_value == check["expected"]
        dimension = check["type"]
        if dimension not in scores:
            raise ValueError(f"unknown verifier score dimension: {dimension}")
        dimension_results.setdefault(dimension, []).append(passed)
        evidence.append(
            {
                "check_id": check["check_id"],
                "artifact": check["artifact"],
                "passed": passed,
            }
        )
    for dimension, results in dimension_results.items():
        scores[dimension] = int(all(results))
    score = {
        "contract_version": CONTRACT_VERSION,
        "kind": "score-vector",
        "score_id": f"score-{sha256_value([run_id, evidence]).split(':')[1][:20]}",
        "run_id": run_id,
        "countability": countability["status"],
        "dimensions": scores,
        "evidence": evidence,
    }
    if qualitative is not None:
        score["qualitative"] = {
            "independent": True,
            "advisory_only": True,
            "assessment": qualitative,
        }
    return validate_contract(score, "score-vector")


def score_eligible_attempt(
    run_id: str,
    verifier: dict[str, Any],
    artifacts: dict[str, Any],
    eligibility: dict[str, Any],
) -> dict[str, Any]:
    """Score only an attempt that passed every deterministic evidence gate."""

    if eligibility.get("status") != "eligible":
        raise ValueError("attempt is not eligible for scoring")
    gates = eligibility.get("gates")
    if not isinstance(gates, dict) or not gates or not all(
        value is True for value in gates.values()
    ):
        raise ValueError("attempt eligibility gates are incomplete")
    score = score_from_verifier(
        run_id,
        verifier,
        artifacts,
        {"status": "countable"},
    )
    repeated = score_from_verifier(
        run_id,
        verifier,
        artifacts,
        {"status": "countable"},
    )
    if score != repeated:
        raise ValueError("deterministic verifier score is not reproducible")
    return score


def compare_pair(
    skill_manifest: dict[str, Any],
    no_skill_manifest: dict[str, Any],
    skill_score: dict[str, Any],
    no_skill_score: dict[str, Any],
) -> str:
    validate_contract(skill_manifest, "run-manifest")
    validate_contract(no_skill_manifest, "run-manifest")
    validate_contract(skill_score, "score-vector")
    validate_contract(no_skill_score, "score-vector")
    validate_pairing(skill_manifest, no_skill_manifest)
    if skill_score["run_id"] != skill_manifest["run_id"]:
        raise ValueError("skill score run_id does not match manifest")
    if no_skill_score["run_id"] != no_skill_manifest["run_id"]:
        raise ValueError("no-skill score run_id does not match manifest")
    if skill_manifest["mode"] != no_skill_manifest["mode"]:
        raise ValueError("scores from different execution modes cannot be combined")
    statuses = {skill_score["countability"], no_skill_score["countability"]}
    if "uncountable" in statuses:
        return "uncountable"
    if statuses != {"countable"}:
        return "non-attributable"
    skill_total = sum(skill_score["dimensions"].values())
    no_skill_total = sum(no_skill_score["dimensions"].values())
    if skill_total > no_skill_total:
        return "positive"
    if skill_total < no_skill_total:
        return "negative"
    return "neutral"


def compare_eligible_pair(
    pair_eligibility: dict[str, Any],
    skill_score: dict[str, Any],
    no_skill_score: dict[str, Any],
) -> str:
    """Compare a pair only after the sealed pair-equality gate passes."""

    if pair_eligibility.get("status") != "comparable":
        raise ValueError("sealed pair is not eligible for comparison")
    gates = pair_eligibility.get("gates")
    if not isinstance(gates, dict) or not gates or not all(
        value is True for value in gates.values()
    ):
        raise ValueError("pair eligibility gates are incomplete")
    validate_contract(skill_score, "score-vector")
    validate_contract(no_skill_score, "score-vector")
    if skill_score["countability"] != "countable":
        raise ValueError("skill score is not countable")
    if no_skill_score["countability"] != "countable":
        raise ValueError("no-skill score is not countable")
    skill_total = sum(skill_score["dimensions"].values())
    no_skill_total = sum(no_skill_score["dimensions"].values())
    if skill_total > no_skill_total:
        return "positive"
    if skill_total < no_skill_total:
        return "negative"
    return "neutral"
