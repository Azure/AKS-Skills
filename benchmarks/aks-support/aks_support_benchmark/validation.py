"""Artifact-derived integrity and countability gates."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .attempts import (
    FailureClass,
    load_sealed_attempt,
    read_sealed_artifact,
    validate_attempt_identity,
)
from .strictjson import StrictJSONError, loads


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

ATTEMPT_GATE_NAMES = (
    "strict_json_schema",
    "accepted_sha",
    "artifact_hashes",
    "identity",
    "condition_skill_identity",
    "complete_trace",
    "zero_tool_calls",
    "prompt_leakage",
    "infrastructure_classification",
)

PAIR_GATE_NAMES = (
    "pair_identity",
    "packet_equal",
    "scaffold_equal",
    "opposite_conditions",
    "condition_skill_identity",
    "attempts_eligible",
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


def evaluate_attempt_eligibility(
    attempt_root: Path,
    *,
    expected_identity: dict[str, Any],
    output_schema: dict[str, type | tuple[type, ...]],
    leakage_markers: list[str] | tuple[str, ...],
    output_artifact: str = "output.json",
    trace_artifact: str = "trace.json",
    required_artifacts: list[str] | tuple[str, ...] = (),
) -> dict[str, Any]:
    """Fail closed on every proof required before deterministic scoring."""

    validate_attempt_identity(expected_identity)
    if not leakage_markers or not all(
        isinstance(marker, str) and marker for marker in leakage_markers
    ):
        raise ValueError("at least one non-empty leakage marker is required")
    _validate_output_schema(output_schema)
    gates = {name: False for name in ATTEMPT_GATE_NAMES}
    details: list[str] = []
    manifest: dict[str, Any] | None = None
    failure_class: FailureClass | None = None

    try:
        manifest = load_sealed_attempt(attempt_root)
        gates["artifact_hashes"] = True
    except (ValueError, OSError) as exc:
        details.append(f"artifact_hashes: {exc}")

    if manifest is not None:
        actual_identity = manifest["identity"]
        gates["accepted_sha"] = (
            actual_identity["accepted_sha"] == expected_identity["accepted_sha"]
        )
        identity_fields = {
            "mode",
            "execution_track",
            "environment",
            "model",
            "fresh_context",
            "pair_id",
            "cell_id",
            "attempt_ordinal",
            "attempt_nonce",
        }
        gates["identity"] = all(
            actual_identity[name] == expected_identity[name] for name in identity_fields
        )
        gates["condition_skill_identity"] = all(
            actual_identity[name] == expected_identity[name]
            for name in ("condition", "skill_hash")
        )
        try:
            failure_class = FailureClass(manifest["failure"]["kind"])
        except ValueError:
            failure_class = None
        gates["infrastructure_classification"] = failure_class is FailureClass.NONE

        declared = {entry["path"] for entry in manifest["artifacts"]}
        required = {output_artifact, trace_artifact, *required_artifacts}
        missing = required - declared
        if missing:
            details.append(f"artifact_hashes: required artifacts missing: {sorted(missing)}")
            gates["artifact_hashes"] = False
        else:
            output_text = _decode_artifact(attempt_root, output_artifact, details)
            if output_text is not None:
                gates["strict_json_schema"] = _output_matches_schema(
                    output_text, output_schema, details
                )
                gates["prompt_leakage"] = not any(
                    marker in output_text for marker in leakage_markers
                )
            trace_text = _decode_artifact(attempt_root, trace_artifact, details)
            if trace_text is not None:
                complete, zero_tools = _trace_proofs(trace_text, details)
                gates["complete_trace"] = complete
                gates["zero_tool_calls"] = zero_tools

    reasons = [name for name in ATTEMPT_GATE_NAMES if not gates[name]]
    if failure_class is FailureClass.PERMANENT_MODEL_CAPABILITY_REJECTION:
        status = "permanent-rejection"
    elif failure_class is not None and failure_class.retryable:
        status = "transient-failure"
    else:
        status = "eligible" if not reasons else "ineligible"
    return {
        "status": status,
        "failure_class": failure_class.value if failure_class is not None else "unproven",
        "retryable": failure_class.retryable if failure_class is not None else False,
        "gates": gates,
        "reasons": reasons,
        "details": details,
    }


def evaluate_pair_eligibility(
    skill_attempt_root: Path,
    no_skill_attempt_root: Path,
    skill_eligibility: dict[str, Any],
    no_skill_eligibility: dict[str, Any],
) -> dict[str, Any]:
    """Prove immutable pair equality without pooling execution tracks."""

    gates = {name: False for name in PAIR_GATE_NAMES}
    details: list[str] = []
    try:
        skill = load_sealed_attempt(skill_attempt_root)["identity"]
        no_skill = load_sealed_attempt(no_skill_attempt_root)["identity"]
    except (ValueError, OSError) as exc:
        details.append(f"pair_identity: {exc}")
    else:
        common_fields = {
            "accepted_sha",
            "mode",
            "execution_track",
            "environment",
            "model",
            "fresh_context",
            "pair_id",
        }
        gates["pair_identity"] = all(
            skill[name] == no_skill[name] for name in common_fields
        )
        gates["packet_equal"] = skill["packet_hash"] == no_skill["packet_hash"]
        gates["scaffold_equal"] = skill["scaffold_hash"] == no_skill["scaffold_hash"]
        gates["opposite_conditions"] = {
            skill["condition"],
            no_skill["condition"],
        } == {"skill", "no-skill"}
        by_condition = {
            skill["condition"]: skill["skill_hash"],
            no_skill["condition"]: no_skill["skill_hash"],
        }
        gates["condition_skill_identity"] = (
            set(by_condition) == {"skill", "no-skill"}
            and isinstance(by_condition["skill"], str)
            and by_condition["no-skill"] is None
        )
    gates["attempts_eligible"] = (
        skill_eligibility.get("status") == "eligible"
        and no_skill_eligibility.get("status") == "eligible"
    )
    reasons = [name for name in PAIR_GATE_NAMES if not gates[name]]
    return {
        "status": "comparable" if not reasons else "ineligible",
        "gates": gates,
        "reasons": reasons,
        "details": details,
    }


def _validate_output_schema(
    schema: dict[str, type | tuple[type, ...]],
) -> None:
    if not isinstance(schema, dict) or not schema:
        raise ValueError("output_schema must declare at least one field")
    for name, expected in schema.items():
        if not isinstance(name, str) or not name:
            raise ValueError("output_schema field names must be non-empty")
        if isinstance(expected, tuple):
            if not expected or not all(isinstance(item, type) for item in expected):
                raise ValueError(f"output_schema[{name!r}] has invalid types")
        elif not isinstance(expected, type):
            raise ValueError(f"output_schema[{name!r}] must be a type or tuple of types")


def _decode_artifact(
    attempt_root: Path, relative_path: str, details: list[str]
) -> str | None:
    try:
        return read_sealed_artifact(attempt_root, relative_path).decode("utf-8")
    except (ValueError, OSError, UnicodeDecodeError) as exc:
        details.append(f"{relative_path}: {exc}")
        return None


def _output_matches_schema(
    text: str,
    schema: dict[str, type | tuple[type, ...]],
    details: list[str],
) -> bool:
    try:
        value = loads(text)
    except StrictJSONError as exc:
        details.append(f"strict_json_schema: {exc}")
        return False
    if not isinstance(value, dict):
        details.append("strict_json_schema: output must be an object")
        return False
    if set(value) != set(schema):
        details.append(
            "strict_json_schema: output fields mismatch; "
            f"missing={sorted(set(schema) - set(value))}, "
            f"unknown={sorted(set(value) - set(schema))}"
        )
        return False
    for name, expected in schema.items():
        actual = value[name]
        if not _matches_expected_type(actual, expected):
            details.append(f"strict_json_schema: field {name!r} has invalid type")
            return False
    return True


def _matches_expected_type(
    value: Any, expected: type | tuple[type, ...]
) -> bool:
    expected_types = expected if isinstance(expected, tuple) else (expected,)
    if type(value) is bool and bool not in expected_types:
        return False
    return isinstance(value, expected_types)


def _trace_proofs(text: str, details: list[str]) -> tuple[bool, bool]:
    try:
        value = loads(text)
    except StrictJSONError as exc:
        details.append(f"complete_trace: {exc}")
        return False, False
    expected = {"complete", "events", "tool_calls"}
    if not isinstance(value, dict) or set(value) != expected:
        details.append("complete_trace: trace fields are missing or unknown")
        return False, False
    complete = (
        value["complete"] is True
        and isinstance(value["events"], list)
        and all(isinstance(event, dict) for event in value["events"])
        and isinstance(value["tool_calls"], list)
    )
    if not complete:
        details.append("complete_trace: trace completeness cannot be proven")
        return False, False
    event_has_tool = any(_is_tool_event(event) for event in value["events"])
    zero_tools = not value["tool_calls"] and not event_has_tool
    if not zero_tools:
        details.append("zero_tool_calls: trace contains a tool event")
    return True, zero_tools


def _is_tool_event(event: dict[str, Any]) -> bool:
    event_type = event.get("type")
    if isinstance(event_type, str) and (
        "tool" in event_type.casefold() or "function_call" in event_type.casefold()
    ):
        return True
    return any(
        isinstance(name, str)
        and (
            name.casefold().startswith("tool")
            or name.casefold().startswith("function_call")
        )
        for name in event
    )
