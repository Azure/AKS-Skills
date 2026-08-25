"""End-to-end direct-context calibration plan, evidence, and reporting flow."""

from __future__ import annotations

import base64
import binascii
from pathlib import Path
from typing import Any

from .attempts import (
    FailureClass,
    load_sealed_attempt,
    read_sealed_artifact,
    seal_attempt,
)
from .calibration import (
    ACCEPTED_ENTRIES_SHA256,
    DIRECT_CONTEXT_SCAFFOLD,
    PUBLIC_CANARY_CASE_IDS,
    SOURCE_COMMIT,
    BundleFile,
    CompleteSkillBundle,
    SolverPacket,
    build_calibration_matrix,
    build_case_packet,
    load_complete_skill_bundle,
)
from .contracts import (
    COPILOT_EXECUTION_ENVIRONMENT,
    COPILOT_EXECUTION_TRACK,
    DIRECT_MODEL_CONTEXT,
)
from .fixture import load_case
from .identity import sha256_bytes, sha256_value
from .one_shot import OneShotOutcome, OneShotRequest, OutcomeStatus, ingest_one_shot_response
from .paths import require_disjoint
from .reporting import build_calibration_report
from .scoring import compare_eligible_pair, score_eligible_attempt
from .strictjson import canonical_bytes, dump, load, loads
from .validation import evaluate_attempt_eligibility, evaluate_pair_eligibility

PLAN_FORMAT_VERSION = "aks-support-calibration-plan/v1"
EXPECTED_BUNDLE_BYTES = 251_082
CAPABILITY_HASH = sha256_value(
    {
        "mode": DIRECT_MODEL_CONTEXT,
        "fresh_context": True,
        "input_messages": 1,
        "tools": [],
        "complete_trace": True,
    }
)
OUTPUT_SCHEMA = {
    "diagnosis.txt": str,
    "evidence.txt": str,
    "mutation.txt": str,
    "uncertainty.txt": str,
}
LEAKAGE_MARKERS = ("VERIFIER-GOLD-CANARY",)


class CalibrationPipelineError(ValueError):
    """Raised when the integrated calibration workflow cannot prove its inputs."""


def build_calibration_plan(repo_root: Path, fixtures_root: Path) -> dict[str, Any]:
    """Freeze the accepted bundle, public cases, and exact 92-cell identity matrix."""

    bundle = load_complete_skill_bundle(repo_root)
    bundle_bytes = sum(len(item.content) for item in bundle.files)
    if bundle_bytes != EXPECTED_BUNDLE_BYTES:
        raise CalibrationPipelineError(
            f"complete skill bundle byte count drift: {bundle_bytes}"
        )

    cases: list[dict[str, Any]] = []
    discovered_case_ids: set[str] = set()
    for case_root in sorted(path.parent for path in fixtures_root.glob("*/case.json")):
        case, _, _ = load_case(case_root)
        if case["case_id"] not in PUBLIC_CANARY_CASE_IDS:
            continue
        packet = build_case_packet(case_root)
        discovered_case_ids.add(case["case_id"])
        cases.append(
            {
                "case_id": case["case_id"],
                "case_packet_base64": base64.b64encode(packet).decode("ascii"),
                "case_packet_bytes": len(packet),
                "case_packet_hash": sha256_bytes(packet),
            }
        )
    if discovered_case_ids != set(PUBLIC_CANARY_CASE_IDS):
        raise CalibrationPipelineError(
            "public calibration cases do not match the accepted case identities"
        )

    return {
        "format_version": PLAN_FORMAT_VERSION,
        "source_commit": SOURCE_COMMIT,
        "mode": DIRECT_MODEL_CONTEXT,
        "blocked_modes": ["agent-folder"],
        "capability_hash": CAPABILITY_HASH,
        "scaffold_base64": base64.b64encode(DIRECT_CONTEXT_SCAFFOLD).decode("ascii"),
        "scaffold_hash": sha256_bytes(DIRECT_CONTEXT_SCAFFOLD),
        "bundle": {
            "entries_digest": bundle.entries_digest,
            "file_count": len(bundle.files),
            "byte_count": bundle_bytes,
            "files": [
                {
                    "logical_path": item.logical_path,
                    "source_entry": item.source_entry,
                    "content_base64": base64.b64encode(item.content).decode("ascii"),
                }
                for item in bundle.files
            ],
        },
        "cases": cases,
        "cells": list(build_calibration_matrix()),
    }


def freeze_calibration_plan(
    repo_root: Path, fixtures_root: Path, output_path: Path
) -> dict[str, Any]:
    """Write a deterministic plan, refusing to replace different frozen bytes."""

    plan = build_calibration_plan(repo_root, fixtures_root)
    content = canonical_bytes(plan) + b"\n"
    if output_path.exists():
        if output_path.read_bytes() != content:
            raise CalibrationPipelineError(
                f"refusing to replace a different frozen plan: {output_path}"
            )
        return plan
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(content)
    return plan


def load_calibration_plan(path: Path) -> dict[str, Any]:
    plan = load(path)
    validate_calibration_plan(plan)
    return plan


def validate_calibration_plan(plan: Any) -> dict[str, Any]:
    expected = {
        "format_version",
        "source_commit",
        "mode",
        "blocked_modes",
        "capability_hash",
        "scaffold_base64",
        "scaffold_hash",
        "bundle",
        "cases",
        "cells",
    }
    if not isinstance(plan, dict) or set(plan) != expected:
        raise CalibrationPipelineError("calibration plan fields are missing or unknown")
    if (
        plan["format_version"] != PLAN_FORMAT_VERSION
        or plan["source_commit"] != SOURCE_COMMIT
        or plan["mode"] != DIRECT_MODEL_CONTEXT
        or plan["blocked_modes"] != ["agent-folder"]
        or plan["capability_hash"] != CAPABILITY_HASH
    ):
        raise CalibrationPipelineError("calibration plan identity drift")

    scaffold = _decode_base64(plan["scaffold_base64"], "scaffold")
    if (
        scaffold != DIRECT_CONTEXT_SCAFFOLD
        or plan["scaffold_hash"] != sha256_bytes(scaffold)
    ):
        raise CalibrationPipelineError("calibration scaffold drift")

    bundle = _bundle_from_plan(plan["bundle"])
    if (
        bundle.source_commit != SOURCE_COMMIT
        or bundle.entries_digest != ACCEPTED_ENTRIES_SHA256
        or len(bundle.files) != 46
        or sum(len(item.content) for item in bundle.files) != EXPECTED_BUNDLE_BYTES
    ):
        raise CalibrationPipelineError("complete skill bundle identity drift")

    if not isinstance(plan["cases"], list):
        raise CalibrationPipelineError("calibration cases must be a list")
    case_ids: set[str] = set()
    for case in plan["cases"]:
        expected_case = {
            "case_id",
            "case_packet_base64",
            "case_packet_bytes",
            "case_packet_hash",
        }
        if not isinstance(case, dict) or set(case) != expected_case:
            raise CalibrationPipelineError("calibration case fields are invalid")
        packet = _decode_base64(case["case_packet_base64"], "case packet")
        if (
            type(case["case_packet_bytes"]) is not int
            or case["case_packet_bytes"] != len(packet)
            or case["case_packet_hash"] != sha256_bytes(packet)
        ):
            raise CalibrationPipelineError("calibration case packet identity drift")
        case_ids.add(case["case_id"])
    if case_ids != set(PUBLIC_CANARY_CASE_IDS) or len(plan["cases"]) != len(case_ids):
        raise CalibrationPipelineError("calibration case identity drift")

    if plan["cells"] != list(build_calibration_matrix()):
        raise CalibrationPipelineError("calibration matrix identity drift")
    return plan


def materialize_calibration_request(
    plan: dict[str, Any], cell_id: str
) -> tuple[OneShotRequest, dict[str, Any]]:
    """Construct one exact request and immutable attempt identity from a frozen plan."""

    validate_calibration_plan(plan)
    cell = next((item for item in plan["cells"] if item["cell_id"] == cell_id), None)
    if cell is None:
        raise CalibrationPipelineError(f"unknown calibration cell: {cell_id}")
    case = next(
        item for item in plan["cases"] if item["case_id"] == cell["case_id"]
    )
    bundle = _bundle_from_plan(plan["bundle"])
    scaffold = _decode_base64(plan["scaffold_base64"], "scaffold")
    case_packet = _decode_base64(case["case_packet_base64"], "case packet")
    skill_available = cell["skill_available"]
    packet = SolverPacket(
        scaffold=scaffold,
        case_packet=case_packet,
        skill_files=bundle.files if skill_available else (),
    )
    prompt = packet.canonical_bytes().decode("ascii")
    request = OneShotRequest(
        request_id=cell["attempt_id"],
        requested_model=cell["model_id"],
        capability_hash=plan["capability_hash"],
        prompt=prompt,
        execution_track=cell["execution_track"],
        execution_environment=cell["execution_environment"],
    )
    pair_id = _pair_id(cell)
    condition = "skill" if skill_available else "no-skill"
    identity = {
        "accepted_sha": plan["source_commit"],
        "mode": cell["mode"],
        "execution_track": cell["execution_track"],
        "environment": cell["execution_environment"],
        "model": cell["model_id"],
        "fresh_context": True,
        "pair_id": pair_id,
        "condition": condition,
        "packet_hash": case["case_packet_hash"],
        "scaffold_hash": plan["scaffold_hash"],
        "skill_hash": plan["bundle"]["entries_digest"] if skill_available else None,
    }
    metadata = {
        "cell": cell,
        "pair_id": pair_id,
        "condition": condition,
        "identity": identity,
        "bundle_bytes": plan["bundle"]["byte_count"] if skill_available else 0,
        "case_packet_bytes": case["case_packet_bytes"],
        "prompt_bytes": len(request.prompt.encode("utf-8")),
        "prompt_hash": sha256_bytes(request.prompt.encode("utf-8")),
    }
    return request, metadata


def calibration_request_record(plan: dict[str, Any], cell_id: str) -> dict[str, Any]:
    request, metadata = materialize_calibration_request(plan, cell_id)
    return {
        "format_version": "aks-support-calibration-request/v1",
        **metadata,
        "capability_hash": request.capability_hash,
        "host_payload": request.host_payload(),
    }


def evaluate_preflight(
    plan: dict[str, Any], cell_id: str, response: Any | None = None
) -> dict[str, Any]:
    """Return proof only from an ingested host response; otherwise remain blocked."""

    request, metadata = materialize_calibration_request(plan, cell_id)
    if metadata["condition"] != "skill":
        raise CalibrationPipelineError("preflight requires a full-bundle skill cell")
    outcome = ingest_one_shot_response(request, response) if response is not None else None
    proven = outcome is not None and outcome.eligible
    return {
        "format_version": "aks-support-calibration-preflight/v1",
        "status": "proven" if proven else "blocked-unproven",
        "disposable": True,
        "cell_id": metadata["cell"]["cell_id"],
        "requested_model": request.requested_model,
        "observed_model": outcome.observed_model if outcome is not None else None,
        "bundle_bytes": metadata["bundle_bytes"],
        "case_packet_bytes": metadata["case_packet_bytes"],
        "prompt_bytes": metadata["prompt_bytes"],
        "proof": {
            "exact_model_identity": proven
            and outcome.observed_model == request.requested_model,
            "complete_trace": proven and _outcome_trace_complete(outcome),
            "zero_tool_trace": proven and _outcome_has_zero_tools(outcome),
            "full_context_fit": proven
            and metadata["bundle_bytes"] == EXPECTED_BUNDLE_BYTES,
        },
        "failure": outcome.failure.as_dict()
        if outcome is not None and outcome.failure is not None
        else None,
    }


def ingest_and_seal_attempt(
    plan: dict[str, Any],
    cell_id: str,
    response: Any,
    staging_root: Path,
    seals_root: Path,
) -> Path:
    """Ingest one host response, persist only sanitized evidence, and seal it once."""

    request, metadata = materialize_calibration_request(plan, cell_id)
    outcome = ingest_one_shot_response(request, response)
    require_disjoint(
        ("attempt staging root", staging_root),
        ("attempt seals root", seals_root),
    )
    source = staging_root / request.request_id
    try:
        source.mkdir(parents=True)
    except FileExistsError as exc:
        raise CalibrationPipelineError(
            f"attempt staging already exists: {request.request_id}"
        ) from exc

    output: Any = {}
    if outcome.output is not None:
        try:
            output = loads(outcome.output)
        except ValueError:
            output = {}
    dump(source / "output.json", output)
    dump(
        source / "trace.json",
        {
            "complete": _outcome_trace_complete(outcome),
            "events": [event.as_dict() for event in outcome.events],
            "tool_calls": [],
        },
    )
    dump(
        source / "outcome.json",
        {
            "request_id": outcome.request_id,
            "requested_model": outcome.requested_model,
            "observed_model": outcome.observed_model,
            "context_id": outcome.context_id,
            "status": outcome.status.value,
            "failure": outcome.failure.as_dict() if outcome.failure else None,
            "capability_hash": outcome.capability_hash,
        },
    )
    failure = (
        FailureClass.NONE
        if outcome.status is OutcomeStatus.ELIGIBLE
        else FailureClass.PERMANENT_MODEL_CAPABILITY_REJECTION
        if outcome.status is OutcomeStatus.PERMANENT_CAPABILITY_REJECTION
        else FailureClass.TRANSIENT_INFRASTRUCTURE_FAILURE
    )
    seal_attempt(
        source,
        seals_root,
        request.request_id,
        [cell["attempt_id"] for cell in plan["cells"]],
        metadata["identity"],
        failure,
        required_artifacts=("outcome.json", "output.json", "trace.json"),
    )
    return seals_root / request.request_id


def regenerate_pipeline_report(
    plan: dict[str, Any],
    seals_root: Path,
    fixtures_root: Path,
    report_id: str,
) -> dict[str, Any]:
    """Apply deterministic gates and pair comparison to every available plan seal."""

    validate_calibration_plan(plan)
    observations: list[dict[str, Any]] = []
    by_pair: dict[str, dict[str, dict[str, Any]]] = {}
    case_roots = {
        load_case(path.parent)[0]["case_id"]: path.parent
        for path in fixtures_root.glob("*/case.json")
    }
    available: list[tuple[dict[str, Any], Path, dict[str, Any]]] = []
    context_counts: dict[str, int] = {}
    for cell in plan["cells"]:
        attempt_root = seals_root / cell["attempt_id"]
        if not attempt_root.is_dir():
            continue
        _, metadata = materialize_calibration_request(plan, cell["cell_id"])
        proof = _load_outcome_proof(attempt_root)
        context_id = proof.get("context_id")
        if isinstance(context_id, str):
            context_counts[context_id] = context_counts.get(context_id, 0) + 1
        available.append((cell, attempt_root, metadata))

    for cell, attempt_root, metadata in available:
        eligibility = evaluate_attempt_eligibility(
            attempt_root,
            expected_identity=metadata["identity"],
            output_schema=OUTPUT_SCHEMA,
            leakage_markers=LEAKAGE_MARKERS,
            required_artifacts=("outcome.json",),
        )
        proof = _load_outcome_proof(attempt_root)
        host_identity = (
            proof.get("request_id") == cell["attempt_id"]
            and proof.get("requested_model") == cell["model_id"]
            and proof.get("observed_model") == cell["model_id"]
            and proof.get("status") == OutcomeStatus.ELIGIBLE.value
            and proof.get("capability_hash") == plan["capability_hash"]
            and proof.get("failure") is None
        )
        context_id = proof.get("context_id")
        fresh_context_unique = (
            isinstance(context_id, str) and context_counts.get(context_id) == 1
        )
        eligibility["gates"]["host_identity"] = host_identity
        eligibility["gates"]["fresh_context_unique"] = fresh_context_unique
        for gate, passed in (
            ("host_identity", host_identity),
            ("fresh_context_unique", fresh_context_unique),
        ):
            if not passed:
                eligibility["reasons"].append(gate)
        if eligibility["status"] == "eligible" and (
            not host_identity or not fresh_context_unique
        ):
            eligibility["status"] = "ineligible"
        score = None
        if eligibility["status"] == "eligible":
            _, _, verifier = load_case(case_roots[cell["case_id"]])
            output = loads(read_sealed_artifact(attempt_root, "output.json").decode())
            score = score_eligible_attempt(
                cell["attempt_id"], verifier, output, eligibility
            )
        manifest = load_sealed_attempt(attempt_root)
        observation = {
            "attempt_id": cell["attempt_id"],
            "manifest_hash": sha256_bytes(
                (attempt_root / "manifest.json").read_bytes()
            ),
            "mode": metadata["identity"]["mode"],
            "execution_track": metadata["identity"]["execution_track"],
            "environment": metadata["identity"]["environment"],
            "model": metadata["identity"]["model"],
            "accepted_sha": metadata["identity"]["accepted_sha"],
            "fresh_context": metadata["identity"]["fresh_context"],
            "pair_id": metadata["pair_id"],
            "condition": metadata["condition"],
            "claim_id": "pipeline-calibration",
            "failure_class": manifest["failure"]["kind"],
            "eligibility": eligibility["status"],
            "score": score,
            "comparison_outcome": None,
        }
        observations.append(observation)
        by_pair.setdefault(metadata["pair_id"], {})[metadata["condition"]] = {
            "root": attempt_root,
            "eligibility": eligibility,
            "score": score,
            "observation": observation,
        }

    for pair in by_pair.values():
        if set(pair) != {"skill", "no-skill"}:
            continue
        pair_eligibility = evaluate_pair_eligibility(
            pair["skill"]["root"],
            pair["no-skill"]["root"],
            pair["skill"]["eligibility"],
            pair["no-skill"]["eligibility"],
        )
        if pair_eligibility["status"] != "comparable":
            continue
        comparison = compare_eligible_pair(
            pair_eligibility,
            pair["skill"]["score"],
            pair["no-skill"]["score"],
        )
        pair["skill"]["observation"]["comparison_outcome"] = comparison
        pair["no-skill"]["observation"]["comparison_outcome"] = comparison
    return build_calibration_report(observations, report_id)


def _bundle_from_plan(value: Any) -> CompleteSkillBundle:
    expected = {"entries_digest", "file_count", "byte_count", "files"}
    if not isinstance(value, dict) or set(value) != expected:
        raise CalibrationPipelineError("calibration bundle fields are invalid")
    if not isinstance(value["files"], list):
        raise CalibrationPipelineError("calibration bundle files must be a list")
    files: list[BundleFile] = []
    entries: list[dict[str, Any]] = []
    for item in value["files"]:
        if not isinstance(item, dict) or set(item) != {
            "logical_path",
            "source_entry",
            "content_base64",
        }:
            raise CalibrationPipelineError("calibration bundle file fields are invalid")
        content = _decode_base64(item["content_base64"], "bundle file")
        source_entry = item["source_entry"]
        if (
            not isinstance(item["logical_path"], str)
            or not isinstance(source_entry, dict)
            or source_entry.get("byte_sha256") != sha256_bytes(content)
            or source_entry.get("size_bytes") != len(content)
        ):
            raise CalibrationPipelineError("calibration bundle file identity drift")
        files.append(BundleFile(item["logical_path"], source_entry, content))
        entries.append(source_entry)
    if (
        value["entries_digest"] != sha256_value(entries)
        or value["file_count"] != len(files)
        or value["byte_count"] != sum(len(item.content) for item in files)
    ):
        raise CalibrationPipelineError("calibration bundle aggregate identity drift")
    return CompleteSkillBundle(SOURCE_COMMIT, value["entries_digest"], tuple(files))


def _decode_base64(value: Any, label: str) -> bytes:
    if not isinstance(value, str):
        raise CalibrationPipelineError(f"{label} must be base64 text")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise CalibrationPipelineError(f"{label} is not valid base64") from exc


def _pair_id(cell: dict[str, Any]) -> str:
    digest = sha256_value(
        {
            "mode": cell["mode"],
            "execution_track": cell["execution_track"],
            "execution_environment": cell["execution_environment"],
            "model_id": cell["model_id"],
            "case_id": cell["case_id"],
        }
    ).split(":", 1)[1]
    return f"pair-{digest[:24]}"


def _outcome_trace_complete(outcome: OneShotOutcome) -> bool:
    return (
        len(outcome.events) >= 2
        and outcome.events[0].name == "request.started"
        and outcome.events[-1].name in {"request.completed", "request.failed"}
    )


def _outcome_has_zero_tools(outcome: OneShotOutcome) -> bool:
    return all(event.category in {"lifecycle", "model", "output"} for event in outcome.events)


def _load_outcome_proof(attempt_root: Path) -> dict[str, Any]:
    try:
        value = loads(read_sealed_artifact(attempt_root, "outcome.json").decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return {}
    expected = {
        "request_id",
        "requested_model",
        "observed_model",
        "context_id",
        "status",
        "failure",
        "capability_hash",
    }
    return value if isinstance(value, dict) and set(value) == expected else {}
