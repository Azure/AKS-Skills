"""Strict one-shot host protocol and zero-tool response ingestion."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Iterable

from .contracts import (
    CONTRACT_VERSION,
    COPILOT_EXECUTION_ENVIRONMENT,
    COPILOT_EXECUTION_TRACK,
    HASH_RE,
    ID_RE,
    RAW_EXECUTION_TRACK,
)

ONE_SHOT_PROTOCOL_VERSION = "aks-support-one-shot/v1"
DIRECT_MODE = "direct-model-context"
_SAFE_PLATFORM_CODE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
_SAFE_CONTEXT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")
_UNSAFE_MESSAGE = re.compile(
    r"(?i)(?:https?://|authorization\s*:|bearer\s+\S+|"
    r"(?:api[_ -]?key|secret|token|endpoint)\s*[:=]\s*\S+|"
    r"^[\[{]|(?:^|\s)/[A-Za-z0-9_.-]+|[A-Za-z]:\\)"
)
_ZERO_TOOL_CATEGORIES = frozenset({"lifecycle", "model", "output"})
_PROHIBITED_CATEGORIES = frozenset({"tool", "file", "shell", "network"})


class OneShotProtocolError(ValueError):
    """Raised when locally constructed one-shot requests are inconsistent."""


class OutcomeStatus(str, Enum):
    ELIGIBLE = "eligible"
    PERMANENT_CAPABILITY_REJECTION = "permanent-capability-rejection"
    TRANSIENT_INFRASTRUCTURE_FAILURE = "transient-infrastructure-failure"


@dataclass(frozen=True)
class FailureEvidence:
    status: OutcomeStatus
    code: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {
            "status": self.status.value,
            "code": self.code,
            "message": self.message,
        }


@dataclass(frozen=True)
class PlatformEvent:
    sequence: int
    category: str
    name: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "sequence": self.sequence,
            "category": self.category,
            "name": self.name,
        }


@dataclass(frozen=True)
class OneShotRequest:
    request_id: str
    requested_model: str
    capability_hash: str
    prompt: str
    execution_track: str = COPILOT_EXECUTION_TRACK
    execution_environment: str = COPILOT_EXECUTION_ENVIRONMENT

    def __post_init__(self) -> None:
        validate_request_fields(
            self.request_id,
            self.requested_model,
            self.capability_hash,
            self.prompt,
            self.execution_track,
            self.execution_environment,
        )

    def host_payload(self) -> dict[str, Any]:
        return {
            "protocol_version": ONE_SHOT_PROTOCOL_VERSION,
            "request_id": self.request_id,
            "model": self.requested_model,
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": self.prompt,
                    }
                ]
            },
            "context": {
                "fresh": True,
                "persist": False,
            },
            "execution": {
                "mode": DIRECT_MODE,
                "track": self.execution_track,
                "environment": self.execution_environment,
            },
            "tools": [],
            "trace": {
                "required": True,
                "include_all_events": True,
            },
        }


@dataclass(frozen=True)
class OneShotOutcome:
    request_id: str
    requested_model: str
    observed_model: str | None
    context_id: str | None
    events: tuple[PlatformEvent, ...]
    output: str | None
    failure: FailureEvidence | None
    capability_hash: str

    @property
    def status(self) -> OutcomeStatus:
        if self.failure is None:
            return OutcomeStatus.ELIGIBLE
        return self.failure.status

    @property
    def eligible(self) -> bool:
        return self.failure is None

    def trajectory(self) -> dict[str, Any]:
        if not self.eligible or self.output is None:
            raise OneShotProtocolError("only eligible outcomes produce trajectories")
        return {
            "contract_version": CONTRACT_VERSION,
            "kind": "trajectory",
            "trajectory_id": self.request_id,
            "mode": DIRECT_MODE,
            "events": [event.as_dict() for event in self.events],
            "final_response": self.output,
            "infrastructure": {
                "failure": False,
                "network_called": False,
                "capability_hash": self.capability_hash,
            },
        }


def _rejection(
    request: OneShotRequest,
    status: OutcomeStatus,
    code: str,
    message: str,
    *,
    observed_model: str | None = None,
    context_id: str | None = None,
    events: tuple[PlatformEvent, ...] = (),
) -> OneShotOutcome:
    return OneShotOutcome(
        request_id=request.request_id,
        requested_model=request.requested_model,
        observed_model=observed_model,
        context_id=context_id,
        events=events,
        output=None,
        failure=FailureEvidence(status=status, code=code, message=message),
        capability_hash=request.capability_hash,
    )


def _permanent(
    request: OneShotRequest,
    code: str,
    message: str,
    **kwargs: Any,
) -> OneShotOutcome:
    return _rejection(
        request,
        OutcomeStatus.PERMANENT_CAPABILITY_REJECTION,
        code,
        message,
        **kwargs,
    )


def _transient(
    request: OneShotRequest,
    code: str,
    message: str,
    **kwargs: Any,
) -> OneShotOutcome:
    return _rejection(
        request,
        OutcomeStatus.TRANSIENT_INFRASTRUCTURE_FAILURE,
        code,
        message,
        **kwargs,
    )


def _parse_events(value: Any) -> tuple[PlatformEvent, ...] | None:
    if not isinstance(value, list):
        return None
    events: list[PlatformEvent] = []
    for expected_sequence, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != {"sequence", "category", "name"}:
            return None
        if type(item["sequence"]) is not int or item["sequence"] != expected_sequence:
            return None
        if (
            not isinstance(item["category"], str)
            or not isinstance(item["name"], str)
            or not _SAFE_PLATFORM_CODE.fullmatch(item["name"])
        ):
            return None
        events.append(
            PlatformEvent(
                sequence=item["sequence"],
                category=item["category"],
                name=item["name"],
            )
        )
    return tuple(events)


def _trace_is_complete(trace: Any, events: tuple[PlatformEvent, ...]) -> bool:
    if not isinstance(trace, dict) or set(trace) != {"complete", "event_count"}:
        return False
    if trace["complete"] is not True:
        return False
    if type(trace["event_count"]) is not int or trace["event_count"] != len(events):
        return False
    if len(events) < 2:
        return False
    return (
        events[0].category == "lifecycle"
        and events[0].name == "request.started"
        and events[-1].category == "lifecycle"
        and events[-1].name in {"request.completed", "request.failed"}
    )


def _safe_platform_failure(value: Any) -> FailureEvidence | None:
    if not isinstance(value, dict) or set(value) != {"status", "code", "message"}:
        return None
    try:
        status = OutcomeStatus(value["status"])
    except (TypeError, ValueError):
        return None
    if status is OutcomeStatus.ELIGIBLE:
        return None
    code = value["code"]
    message = value["message"]
    if not isinstance(code, str) or not _SAFE_PLATFORM_CODE.fullmatch(code):
        return None
    if (
        not isinstance(message, str)
        or not message
        or message != message.strip()
        or any(ord(character) < 32 for character in message)
        or _UNSAFE_MESSAGE.search(message)
    ):
        return None
    return FailureEvidence(status=status, code=code, message=message)


def _metadata_context_id(value: Any, request: OneShotRequest) -> str | None:
    if not isinstance(value, dict):
        return None
    expected = {
        "mode",
        "execution_track",
        "execution_environment",
        "context_id",
        "fresh_context",
        "input_message_count",
        "prior_message_count",
        "input_bytes",
        "input_sha256",
    }
    if set(value) != expected:
        return None
    if (
        value["mode"] != DIRECT_MODE
        or value["execution_track"] != request.execution_track
        or value["execution_environment"] != request.execution_environment
        or value["fresh_context"] is not True
        or type(value["input_message_count"]) is not int
        or value["input_message_count"] != 1
        or type(value["prior_message_count"]) is not int
        or value["prior_message_count"] != 0
        or type(value["input_bytes"]) is not int
        or value["input_bytes"] != len(request.prompt.encode("utf-8"))
        or value["input_sha256"]
        != f"sha256:{hashlib.sha256(request.prompt.encode('utf-8')).hexdigest()}"
    ):
        return None
    context_id = value["context_id"]
    if not isinstance(context_id, str) or not _SAFE_CONTEXT_ID.fullmatch(context_id):
        return None
    return context_id


def ingest_one_shot_response(
    request: OneShotRequest, response: Any
) -> OneShotOutcome:
    """Validate and ingest a normalized host response without retaining unsafe fields."""

    expected = {
        "protocol_version",
        "request_id",
        "requested_model",
        "observed_model",
        "output",
        "events",
        "trace",
        "solver_metadata",
        "failure",
    }
    if not isinstance(response, dict) or set(response) != expected:
        return _permanent(
            request,
            "malformed-response",
            "The one-shot host response did not match the required envelope.",
        )
    if (
        response["protocol_version"] != ONE_SHOT_PROTOCOL_VERSION
        or response["request_id"] != request.request_id
        or response["requested_model"] != request.requested_model
    ):
        return _permanent(
            request,
            "response-correlation-mismatch",
            "The one-shot host response did not match the request identity.",
        )

    context_id = _metadata_context_id(response["solver_metadata"], request)
    if context_id is None:
        return _permanent(
            request,
            "solver-metadata-rejected",
            "Solver metadata was incomplete, inconsistent, or contained prohibited fields.",
        )

    events = _parse_events(response["events"])
    if events is None or not _trace_is_complete(response["trace"], events):
        return _transient(
            request,
            "trace-incomplete",
            "A complete contiguous platform event trace could not be proven.",
            context_id=context_id,
        )

    observed_model = response["observed_model"]
    if observed_model is not None and not isinstance(observed_model, str):
        return _permanent(
            request,
            "malformed-model-identity",
            "The observed model identity was malformed.",
            context_id=context_id,
            events=events,
        )

    invalid_categories = {
        event.category for event in events if event.category not in _ZERO_TOOL_CATEGORIES
    }
    prohibited_names = {
        event.name.split(".", 1)[0]
        for event in events
        if event.name.split(".", 1)[0] in _PROHIBITED_CATEGORIES
    }
    if invalid_categories or prohibited_names:
        code = (
            "prohibited-invocation"
            if invalid_categories & _PROHIBITED_CATEGORIES or prohibited_names
            else "unknown-event-category"
        )
        return _permanent(
            request,
            code,
            "The platform trace contained a prohibited or unrecognized invocation category.",
            observed_model=observed_model,
            context_id=context_id,
            events=events,
        )

    failure_value = response["failure"]
    if failure_value is not None:
        failure = _safe_platform_failure(failure_value)
        if failure is None or response["output"] is not None:
            return _permanent(
                request,
                "unsafe-failure-evidence",
                "Platform failure evidence was malformed or unsafe to retain.",
                observed_model=observed_model,
                context_id=context_id,
                events=events,
            )
        return _rejection(
            request,
            failure.status,
            failure.code,
            failure.message,
            observed_model=observed_model,
            context_id=context_id,
            events=events,
        )

    if observed_model != request.requested_model:
        return _permanent(
            request,
            "model-identity-mismatch",
            "Requested and observed model identities did not match exactly.",
            observed_model=observed_model,
            context_id=context_id,
            events=events,
        )

    required_events = {"model.requested", "model.observed", "output.emitted"}
    if (
        events[-1].name != "request.completed"
        or not required_events.issubset(event.name for event in events)
    ):
        return _transient(
            request,
            "trace-incomplete",
            "The complete success event sequence could not be proven.",
            observed_model=observed_model,
            context_id=context_id,
            events=events,
        )

    output = response["output"]
    if (
        not isinstance(output, dict)
        or set(output) != {"content_type", "content"}
        or output.get("content_type") != "text/plain"
        or not isinstance(output.get("content"), str)
        or not output["content"].strip()
    ):
        return _permanent(
            request,
            "malformed-output",
            "The solver output was missing or malformed.",
            observed_model=observed_model,
            context_id=context_id,
            events=events,
        )

    return OneShotOutcome(
        request_id=request.request_id,
        requested_model=request.requested_model,
        observed_model=observed_model,
        context_id=context_id,
        events=events,
        output=output["content"],
        failure=None,
        capability_hash=request.capability_hash,
    )


def adapter_transport_failure(request: OneShotRequest) -> OneShotOutcome:
    """Create sanitized transient evidence for a failed adapter exchange."""

    return _transient(
        request,
        "adapter-transport-failure",
        "The one-shot adapter did not return a structured response.",
    )


def validate_distinct_requests(requests: Iterable[OneShotRequest]) -> None:
    request_ids = [request.request_id for request in requests]
    if len(request_ids) != len(set(request_ids)):
        raise OneShotProtocolError("each cell requires a distinct one-shot request")


def validate_distinct_contexts(outcomes: Iterable[OneShotOutcome]) -> None:
    context_ids = [outcome.context_id for outcome in outcomes]
    if any(context_id is None for context_id in context_ids):
        raise OneShotProtocolError("every cell requires fresh-context evidence")
    if len(context_ids) != len(set(context_ids)):
        raise OneShotProtocolError("solver contexts were reused across cells")


def validate_request_fields(
    request_id: str,
    requested_model: str,
    capability_hash: str,
    prompt: str,
    execution_track: str = COPILOT_EXECUTION_TRACK,
    execution_environment: str = COPILOT_EXECUTION_ENVIRONMENT,
) -> None:
    if not isinstance(request_id, str) or not ID_RE.fullmatch(request_id):
        raise OneShotProtocolError("request_id must be a benchmark identifier")
    if (
        not isinstance(requested_model, str)
        or not requested_model.strip()
        or any(ord(character) < 32 for character in requested_model)
    ):
        raise OneShotProtocolError("requested_model must be a non-empty identity")
    if not isinstance(capability_hash, str) or not HASH_RE.fullmatch(capability_hash):
        raise OneShotProtocolError("capability_hash must be a SHA-256 identity")
    if not isinstance(prompt, str) or not prompt:
        raise OneShotProtocolError("prompt must not be empty")
    if execution_track not in {COPILOT_EXECUTION_TRACK, RAW_EXECUTION_TRACK}:
        raise OneShotProtocolError("execution_track is not supported")
    if (
        not isinstance(execution_environment, str)
        or not ID_RE.fullmatch(execution_environment)
    ):
        raise OneShotProtocolError("execution_environment must be an identifier")
