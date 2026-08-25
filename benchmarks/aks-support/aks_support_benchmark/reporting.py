"""Append-only result persistence and artifact-only report regeneration."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .attempts import load_sealed_attempt, read_sealed_artifact
from .contracts import CONTRACT_VERSION, validate_contract
from .identity import sha256_bytes, sha256_value
from .strictjson import StrictJSONError, canonical_bytes, load_jsonl, loads


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
    comparable = [item for item in countable if "comparison_outcome" in item]
    assessments: list[dict[str, Any]] = []
    for claim in claim_plan["claims"]:
        claim_id = claim.get("claim_id")
        for mode in ("direct-model-context", "agent-folder"):
            matching = [
                item
                for item in comparable
                if item["claim_id"] == claim_id and item["mode"] == mode
            ]
            assessments.append(
                {
                    "claim_id": claim_id,
                    "mode": mode,
                    "status": "descriptive",
                    "countable_results": len(matching),
                }
            )
    report = {
        "contract_version": CONTRACT_VERSION,
        "kind": "report",
        "report_id": report_id,
        "result_hashes": result_hashes,
        "claim_assessment": assessments,
        "status": "descriptive-preliminary",
        "rankings": [],
    }
    return validate_contract(report, "report")


def regenerate_calibration_report(
    attempt_roots: list[Path] | tuple[Path, ...],
    report_id: str,
    *,
    result_artifact: str = "calibration-result.json",
) -> dict[str, Any]:
    """Regenerate a track-separated descriptive report from sealed evidence."""

    if not isinstance(report_id, str) or not report_id:
        raise ResultStoreError("report_id must be non-empty")
    observations: list[dict[str, Any]] = []
    attempt_ids: set[str] = set()
    cells: set[tuple[str, ...]] = set()
    for attempt_root in sorted(attempt_roots, key=lambda path: path.as_posix()):
        manifest = load_sealed_attempt(attempt_root)
        attempt_id = manifest["attempt_id"]
        if attempt_id in attempt_ids:
            raise ResultStoreError(f"duplicate sealed attempt_id: {attempt_id}")
        attempt_ids.add(attempt_id)
        result = _load_calibration_result(attempt_root, result_artifact)
        if result["attempt_id"] != attempt_id:
            raise ResultStoreError("calibration result attempt_id does not match seal")
        identity = manifest["identity"]
        cell = (
            identity["mode"],
            identity["execution_track"],
            identity["environment"],
            identity["model"],
            identity["pair_id"],
            identity["condition"],
            result["claim_id"],
        )
        if cell in cells:
            raise ResultStoreError(f"more than one observation for cell: {cell}")
        cells.add(cell)
        manifest_bytes = (attempt_root / "manifest.json").read_bytes()
        observations.append(
            {
                "attempt_id": attempt_id,
                "manifest_hash": sha256_bytes(manifest_bytes),
                "mode": identity["mode"],
                "execution_track": identity["execution_track"],
                "environment": identity["environment"],
                "model": identity["model"],
                "accepted_sha": identity["accepted_sha"],
                "fresh_context": identity["fresh_context"],
                "pair_id": identity["pair_id"],
                "condition": identity["condition"],
                "claim_id": result["claim_id"],
                "failure_class": manifest["failure"]["kind"],
                "eligibility": result["eligibility"],
                "score": result["score"],
                "comparison_outcome": result["comparison_outcome"],
            }
        )

    return build_calibration_report(observations, report_id)


def build_calibration_report(
    observations: list[dict[str, Any]], report_id: str
) -> dict[str, Any]:
    """Build the common track-separated, claim-limited calibration report."""

    if not isinstance(report_id, str) or not report_id:
        raise ResultStoreError("report_id must be non-empty")
    partitions: list[dict[str, Any]] = []
    partition_keys = sorted(
        {
            (
                item["mode"],
                item["execution_track"],
                item["environment"],
            )
            for item in observations
        }
    )
    for mode, execution_track, environment in partition_keys:
        matching = [
            item
            for item in observations
            if (
                item["mode"],
                item["execution_track"],
                item["environment"],
            )
            == (mode, execution_track, environment)
        ]
        partitions.append(
            {
                "mode": mode,
                "execution_track": execution_track,
                "environment": environment,
                "observations": sorted(
                    matching,
                    key=lambda item: (
                        item["model"],
                        item["pair_id"],
                        item["condition"],
                        item["claim_id"],
                        item["attempt_id"],
                    ),
                ),
            }
        )
    return {
        "format_version": "aks-support-calibration-report/v1",
        "report_id": report_id,
        "status": "descriptive-pipeline-calibration",
        "claim_boundary": (
            "One observation per cell. This report makes no ranking, uplift, "
            "superiority, confidence, skill-effect, or product-quality claim."
        ),
        "partitions": partitions,
    }


def calibration_report_bytes(
    attempt_roots: list[Path] | tuple[Path, ...],
    report_id: str,
    *,
    result_artifact: str = "calibration-result.json",
) -> bytes:
    """Return the canonical byte-identical representation of a sealed report."""

    return (
        canonical_bytes(
            regenerate_calibration_report(
                attempt_roots,
                report_id,
                result_artifact=result_artifact,
            )
        )
        + b"\n"
    )


def _load_calibration_result(
    attempt_root: Path, result_artifact: str
) -> dict[str, Any]:
    try:
        value = loads(read_sealed_artifact(attempt_root, result_artifact).decode("utf-8"))
    except (StrictJSONError, UnicodeDecodeError) as exc:
        raise ResultStoreError("calibration result is not strict UTF-8 JSON") from exc
    expected = {
        "attempt_id",
        "claim_id",
        "eligibility",
        "score",
        "comparison_outcome",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise ResultStoreError("calibration result fields are missing or unknown")
    for name in ("attempt_id", "claim_id"):
        if not isinstance(value[name], str) or not value[name]:
            raise ResultStoreError(f"calibration result {name} must be non-empty")
    if value["eligibility"] not in {
        "eligible",
        "ineligible",
        "permanent-rejection",
        "transient-failure",
    }:
        raise ResultStoreError("calibration result eligibility is invalid")
    if value["score"] is not None and not isinstance(value["score"], dict):
        raise ResultStoreError("calibration result score must be an object or null")
    if isinstance(value["score"], dict) and "qualitative" in value["score"]:
        raise ResultStoreError("qualitative judging is not part of calibration")
    if value["comparison_outcome"] not in {
        None,
        "positive",
        "neutral",
        "negative",
    }:
        raise ResultStoreError("calibration result comparison_outcome is invalid")
    if value["eligibility"] != "eligible" and (
        value["score"] is not None or value["comparison_outcome"] is not None
    ):
        raise ResultStoreError("ineligible calibration result must not contain a score")
    return value
