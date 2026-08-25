"""Versioned strict benchmark contracts."""

from __future__ import annotations

import re
from datetime import date
from dataclasses import dataclass
from typing import Any, Callable

from .paths import normalized_relative

CONTRACT_VERSION = "aks-support-benchmark/v1"
HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
COPILOT_MODEL_IDS = (
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-opus-4.8",
    "claude-opus-4.7",
    "claude-sonnet-4.6",
    "claude-opus-4.6",
    "claude-haiku-4.5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5-mini",
    "mai-code-1-flash-picker",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "grok-4.5",
    "grok-4.6",
    "mai-code-1.1-flash",
)
DIRECT_MODEL_CONTEXT = "direct-model-context"
COPILOT_EXECUTION_TRACK = "copilot-agent"
COPILOT_EXECUTION_ENVIRONMENT = "github-copilot-subagent"
RAW_EXECUTION_TRACK = "raw-model"
ATTEMPT_OUTCOME_IDENTITIES = (
    "completed",
    "permanent-capability",
    "transient-infrastructure",
)


class ContractError(ValueError):
    """Raised when a contract does not match its declared schema."""


@dataclass(frozen=True)
class Field:
    expected: type | tuple[type, ...]
    required: bool = True
    item_type: type | tuple[type, ...] | None = None
    validator: Callable[[Any], None] | None = None


def _identifier(value: Any) -> None:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise ContractError(f"invalid identifier: {value!r}")


def _version(value: Any) -> None:
    if value != CONTRACT_VERSION:
        raise ContractError(f"unsupported contract version: {value!r}")


def _hash(value: Any) -> None:
    if not isinstance(value, str) or not HASH_RE.fullmatch(value):
        raise ContractError(f"invalid content hash: {value!r}")


def _relative(value: Any) -> None:
    try:
        normalized_relative(value)
    except ValueError as exc:
        raise ContractError(str(exc)) from exc


def _nonempty(value: Any) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ContractError("string must not be empty")


def _mode(value: Any) -> None:
    if value not in ("direct-model-context", "agent-folder"):
        raise ContractError(f"invalid execution mode: {value!r}")


def _copilot_model(value: Any) -> None:
    if value not in COPILOT_MODEL_IDS:
        raise ContractError(f"unsupported explicit Copilot model ID: {value!r}")


def _execution_track(value: Any) -> None:
    if value not in (COPILOT_EXECUTION_TRACK, RAW_EXECUTION_TRACK):
        raise ContractError(f"invalid execution track: {value!r}")


def _execution_environment(value: Any) -> None:
    _identifier(value)


def _attempt_outcome(value: Any) -> None:
    if value not in ATTEMPT_OUTCOME_IDENTITIES:
        raise ContractError(f"invalid attempt outcome identity: {value!r}")


def _outcome(value: Any) -> None:
    if value not in (
        "positive",
        "neutral",
        "negative",
        "uncountable",
        "non-attributable",
    ):
        raise ContractError(f"invalid comparison outcome: {value!r}")


def _status(value: Any) -> None:
    if value not in ("countable", "uncountable", "non-attributable"):
        raise ContractError(f"invalid countability status: {value!r}")


def _score(value: Any) -> None:
    if type(value) is not int or value not in (0, 1):
        raise ContractError("deterministic dimension score must be 0 or 1")


BASE = {
    "contract_version": Field(str, validator=_version),
    "kind": Field(str),
}

SCHEMAS: dict[str, dict[str, Field]] = {
    "canary-set": {
        **BASE,
        "set_id": Field(str, validator=_identifier),
        "cases": Field(list, item_type=str),
    },
    "case": {
        **BASE,
        "case_id": Field(str, validator=_identifier),
        "title": Field(str, validator=_nonempty),
        "set": Field(str, validator=_identifier),
        "source_refs": Field(list, item_type=dict),
        "task_path": Field(str, validator=_relative),
        "verifier_path": Field(str, validator=_relative),
        "answer_path": Field(str, required=False, validator=_relative),
        "tags": Field(list, item_type=str),
    },
    "task": {
        **BASE,
        "task_id": Field(str, validator=_identifier),
        "case_id": Field(str, validator=_identifier),
        "prompt": Field(str, validator=_nonempty),
        "workspace_files": Field(list, item_type=dict),
        "allowed_tools": Field(list, item_type=str),
        "prohibited_actions": Field(list, item_type=str),
    },
    "claim-plan": {
        **BASE,
        "plan_id": Field(str, validator=_identifier),
        "claims": Field(list, item_type=dict),
        "pairing_constants": Field(list, item_type=str),
        "analysis": Field(dict),
        "ranking_policy": Field(dict),
    },
    "capability-profile": {
        **BASE,
        "profile_id": Field(str, validator=_identifier),
        "model": Field(dict),
        "host": Field(dict),
        "adapter": Field(dict),
        "tools": Field(list, item_type=dict),
        "posture": Field(str, validator=_identifier),
    },
    "adapter-config": {
        **BASE,
        "adapter_id": Field(str, validator=_identifier),
        "adapter_type": Field(str, validator=_identifier),
        "argv": Field(list, required=False, item_type=str),
        "allowed_env": Field(list, item_type=str),
        "config": Field(dict),
    },
    "skill-bundle": {
        **BASE,
        "bundle_id": Field(str, validator=_identifier),
        "root": Field(str, validator=_relative),
        "files": Field(list, item_type=dict),
        "bundle_hash": Field(str, validator=_hash),
    },
    "trajectory": {
        **BASE,
        "trajectory_id": Field(str, validator=_identifier),
        "mode": Field(str, validator=_mode),
        "events": Field(list, item_type=dict),
        "final_response": Field(str),
        "infrastructure": Field(dict),
    },
    "verifier": {
        **BASE,
        "verifier_id": Field(str, validator=_identifier),
        "checks": Field(list, item_type=dict),
        "gold_files": Field(list, item_type=str),
        "verifier_hash": Field(str, validator=_hash),
    },
    "run-manifest": {
        **BASE,
        "run_id": Field(str, validator=_identifier),
        "release_id": Field(str, validator=_identifier),
        "mode": Field(str, validator=_mode),
        "pair_id": Field(str, validator=_identifier),
        "skill_available": Field(bool),
        "repetition": Field(int),
        "seed": Field(str),
        "identities": Field(dict),
        "capability_profile": Field(dict),
        "budgets": Field(dict),
        "retry_policy": Field(dict),
        "execution_track": Field(
            str, required=False, validator=_execution_track
        ),
        "execution_environment": Field(
            str, required=False, validator=_execution_environment
        ),
        "fresh_context_id": Field(
            str, required=False, validator=_identifier
        ),
        "attempt_id": Field(str, required=False, validator=_identifier),
    },
    "calibration-cell": {
        **BASE,
        "cell_id": Field(str, validator=_identifier),
        "mode": Field(str, validator=_mode),
        "execution_track": Field(str, validator=_execution_track),
        "execution_environment": Field(str, validator=_execution_environment),
        "model_id": Field(str, validator=_copilot_model),
        "case_id": Field(str, validator=_identifier),
        "skill_available": Field(bool),
        "fresh_context_id": Field(str, validator=_identifier),
        "attempt_id": Field(str, validator=_identifier),
    },
    "attempt-outcome": {
        **BASE,
        "attempt_id": Field(str, validator=_identifier),
        "cell_id": Field(str, validator=_identifier),
        "outcome_identity": Field(str, validator=_attempt_outcome),
        "detail": Field(str, validator=_nonempty),
    },
    "score-vector": {
        **BASE,
        "score_id": Field(str, validator=_identifier),
        "run_id": Field(str, validator=_identifier),
        "countability": Field(str, validator=_status),
        "dimensions": Field(dict),
        "qualitative": Field(dict, required=False),
        "evidence": Field(list, item_type=dict),
    },
    "result": {
        **BASE,
        "result_id": Field(str, validator=_identifier),
        "run_id": Field(str, validator=_identifier),
        "claim_id": Field(str, validator=_identifier),
        "mode": Field(str, validator=_mode),
        "manifest_hash": Field(str, validator=_hash),
        "trajectory_hash": Field(str, validator=_hash),
        "score_hash": Field(str, validator=_hash),
        "countability": Field(str, validator=_status),
        "comparison_outcome": Field(str, required=False, validator=_outcome),
    },
    "report": {
        **BASE,
        "report_id": Field(str, validator=_identifier),
        "result_hashes": Field(list, item_type=str),
        "claim_assessment": Field(list, item_type=dict),
        "status": Field(str, validator=_identifier),
        "rankings": Field(list, item_type=dict),
    },
}


def _strict_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{label} must be an object")
    return value


def _check_nested_entries(kind: str, value: dict[str, Any]) -> None:
    if kind == "canary-set":
        if not value["cases"]:
            raise ContractError("canary set must declare cases")
        if len(set(value["cases"])) != len(value["cases"]):
            raise ContractError("canary set contains duplicate case paths")
        for path in value["cases"]:
            _relative(path)
    elif kind == "case":
        for index, ref in enumerate(value["source_refs"]):
            _exact_keys(ref, {"url", "verified_on"}, f"source_refs[{index}]")
            if not isinstance(ref["url"], str) or not re.fullmatch(
                r"https://[^\s]+", ref["url"]
            ):
                raise ContractError("source URL must use HTTPS")
            if not isinstance(ref["verified_on"], str):
                raise ContractError("verified_on must be YYYY-MM-DD")
            try:
                date.fromisoformat(ref["verified_on"])
            except ValueError as exc:
                raise ContractError("verified_on must be a real YYYY-MM-DD date") from exc
    elif kind == "task":
        for index, entry in enumerate(value["workspace_files"]):
            _exact_keys(entry, {"path", "sha256"}, f"workspace_files[{index}]")
            _relative(entry["path"])
            _hash(entry["sha256"])
    elif kind == "skill-bundle":
        if not value["files"]:
            raise ContractError("skill bundle must declare at least one file")
        paths: set[str] = set()
        for index, entry in enumerate(value["files"]):
            _exact_keys(entry, {"path", "sha256", "size"}, f"files[{index}]")
            _relative(entry["path"])
            _hash(entry["sha256"])
            if type(entry["size"]) is not int or entry["size"] < 0:
                raise ContractError("skill file size must be a non-negative integer")
            if entry["path"] in paths:
                raise ContractError(f"duplicate skill file path: {entry['path']}")
            paths.add(entry["path"])
    elif kind == "verifier":
        for path in value["gold_files"]:
            _relative(path)
        for index, check in enumerate(value["checks"]):
            _exact_keys(
                check,
                {"check_id", "type", "artifact", "expected"},
                f"checks[{index}]",
            )
            _identifier(check["check_id"])
            _relative(check["artifact"])
    elif kind == "score-vector":
        expected = {
            "outcome_root_cause",
            "decisive_evidence",
            "distractor_rejection",
            "routing_escalation",
            "safe_remediation",
            "communication_uncertainty",
            "tool_efficiency",
            "infrastructure_status",
        }
        _exact_keys(value["dimensions"], expected, "dimensions")
        for score in value["dimensions"].values():
            _score(score)
    elif kind == "run-manifest":
        required = {
            "benchmark",
            "task",
            "environment",
            "verifier",
            "model",
            "scaffold",
            "prompt",
            "skill",
            "tools",
            "budget",
            "retry",
        }
        _exact_keys(value["identities"], required, "identities")
        for digest in value["identities"].values():
            _hash(digest)
        if type(value["repetition"]) is not int or value["repetition"] < 0:
            raise ContractError("repetition must be a non-negative integer")
        direct_identity_fields = {
            "execution_track",
            "execution_environment",
            "fresh_context_id",
            "attempt_id",
        }
        present = direct_identity_fields & set(value)
        if present and present != direct_identity_fields:
            missing = sorted(direct_identity_fields - present)
            raise ContractError(
                f"direct execution identity is incomplete; missing={missing}"
            )
        if present and value["mode"] != DIRECT_MODEL_CONTEXT:
            raise ContractError(
                "direct execution identity requires direct-model-context mode"
            )
    elif kind == "calibration-cell":
        if value["mode"] != DIRECT_MODEL_CONTEXT:
            raise ContractError(
                "calibration cell requires direct-model-context mode"
            )
        if value["execution_track"] != COPILOT_EXECUTION_TRACK:
            raise ContractError("calibration cell requires copilot-agent track")
        if value["execution_environment"] != COPILOT_EXECUTION_ENVIRONMENT:
            raise ContractError(
                "calibration cell requires github-copilot-subagent environment"
            )
        if value["fresh_context_id"] == value["attempt_id"]:
            raise ContractError("fresh_context_id and attempt_id must differ")
    elif kind == "trajectory":
        _exact_keys(
            value["infrastructure"],
            {"failure", "network_called", "capability_hash"},
            "infrastructure",
        )
        if type(value["infrastructure"]["failure"]) is not bool:
            raise ContractError("infrastructure.failure must be boolean")
        if type(value["infrastructure"]["network_called"]) is not bool:
            raise ContractError("infrastructure.network_called must be boolean")
        _hash(value["infrastructure"]["capability_hash"])
    elif kind == "report":
        for digest in value["result_hashes"]:
            _hash(digest)
        for index, assessment in enumerate(value["claim_assessment"]):
            _exact_keys(
                assessment,
                {"claim_id", "mode", "status", "countable_results"},
                f"claim_assessment[{index}]",
            )
            _identifier(assessment["claim_id"])
            _mode(assessment["mode"])
            if assessment["status"] not in ("evaluated", "descriptive"):
                raise ContractError("claim assessment status is invalid")
            if (
                type(assessment["countable_results"]) is not int
                or assessment["countable_results"] < 0
            ):
                raise ContractError(
                    "claim assessment countable_results must be non-negative"
                )
        for index, ranking in enumerate(value["rankings"]):
            _exact_keys(
                ranking,
                {"mode", "outcome", "count"},
                f"rankings[{index}]",
            )
            _mode(ranking["mode"])
            _outcome(ranking["outcome"])
            if type(ranking["count"]) is not int or ranking["count"] <= 0:
                raise ContractError("ranking count must be a positive integer")


def _exact_keys(value: Any, expected: set[str], label: str) -> None:
    obj = _strict_object(value, label)
    missing = expected - set(obj)
    unknown = set(obj) - expected
    if missing or unknown:
        raise ContractError(
            f"{label} fields mismatch; missing={sorted(missing)}, unknown={sorted(unknown)}"
        )


def validate_contract(value: Any, expected_kind: str | None = None) -> dict[str, Any]:
    obj = _strict_object(value, "contract")
    kind = obj.get("kind")
    if expected_kind is not None and kind != expected_kind:
        raise ContractError(f"expected kind {expected_kind!r}, got {kind!r}")
    if kind not in SCHEMAS:
        raise ContractError(f"unknown contract kind: {kind!r}")
    schema = SCHEMAS[kind]
    required = {name for name, field in schema.items() if field.required}
    missing = required - set(obj)
    unknown = set(obj) - set(schema)
    if missing or unknown:
        raise ContractError(
            f"{kind} fields mismatch; missing={sorted(missing)}, unknown={sorted(unknown)}"
        )
    for name, field in schema.items():
        if name not in obj:
            continue
        value = obj[name]
        if not isinstance(value, field.expected) or (
            field.expected is int and type(value) is not int
        ):
            raise ContractError(
                f"{kind}.{name} must be {field.expected}, got {type(value).__name__}"
            )
        if field.item_type is not None:
            for index, item in enumerate(value):
                if not isinstance(item, field.item_type):
                    raise ContractError(
                        f"{kind}.{name}[{index}] has invalid type {type(item).__name__}"
                    )
        if field.validator is not None:
            field.validator(value)
    _check_nested_entries(kind, obj)
    return obj
