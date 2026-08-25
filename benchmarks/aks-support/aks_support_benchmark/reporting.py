"""Append-only result persistence and artifact-only report regeneration."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .contracts import CONTRACT_VERSION, validate_contract
from .identity import sha256_value
from .strictjson import canonical_bytes, load_jsonl


class ResultStoreError(ValueError):
    """Raised when an append-only result store is invalid."""


def append_result(path: Path, result: dict[str, Any]) -> str:
    validated = validate_contract(result, "result")
    digest = sha256_value(validated)
    if path.exists():
        existing = load_jsonl(path)
        if any(item.get("result_id") == validated["result_id"] for item in existing):
            raise ResultStoreError(f"result_id already exists: {validated['result_id']}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(descriptor, canonical_bytes(validated) + b"\n")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return digest


def regenerate_report(
    results_path: Path, claim_plan: dict[str, Any], report_id: str
) -> dict[str, Any]:
    validate_contract(claim_plan, "claim-plan")
    results = [
        validate_contract(item, "result") for item in load_jsonl(results_path)
    ]
    result_hashes = [sha256_value(item) for item in results]
    countable = [item for item in results if item["countability"] == "countable"]
    assessments: list[dict[str, Any]] = []
    rankings_allowed = bool(countable) and bool(
        claim_plan["ranking_policy"].get("uncertainty_sufficient")
    )
    for claim in claim_plan["claims"]:
        claim_id = claim.get("claim_id")
        matching = [
            item
            for item in countable
            if item["claim_id"] == claim_id and item.get("comparison_outcome")
        ]
        assessments.append(
            {
                "claim_id": claim_id,
                "status": "evaluated" if matching else "descriptive",
                "countable_results": len(matching),
            }
        )
    report = {
        "contract_version": CONTRACT_VERSION,
        "kind": "report",
        "report_id": report_id,
        "result_hashes": result_hashes,
        "claim_assessment": assessments,
        "status": "rankable" if rankings_allowed else "descriptive-preliminary",
        "rankings": [] if not rankings_allowed else _rankings(countable),
    }
    return validate_contract(report, "report")


def _rankings(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    outcomes: dict[str, int] = {}
    for result in results:
        outcome = result.get("comparison_outcome", "neutral")
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
    return [
        {"outcome": outcome, "count": count}
        for outcome, count in sorted(outcomes.items())
    ]
