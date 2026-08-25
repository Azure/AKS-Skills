"""Offline harness smoke self-test with no model-performance claim."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .adapters import RecordedAdapter
from .contracts import CONTRACT_VERSION
from .fixture import discover_cases, load_case
from .identity import sha256_value
from .scoring import score_from_verifier
from .strictjson import load
from .validation import evaluate_gates


def run_smoke(fixtures_root: Path) -> dict[str, Any]:
    cases = discover_cases(fixtures_root)
    if not cases:
        raise ValueError("no public canary fixtures found")
    case, task, verifier = load_case(cases[0])
    trajectory = RecordedAdapter(cases[0] / "recorded" / "trajectory.json").invoke({})
    observation = {
        "trace_available": bool(trajectory["events"]),
        "observed": [],
        "missing": [],
    }
    benchmark_root = fixtures_root.resolve().parents[1]
    capability_hash = sha256_value(
        load(benchmark_root / "contracts" / "capability-profile.json")
    )
    invoked_tools = {
        event.get("tool")
        for event in trajectory["events"]
        if event.get("type") == "tool-invoked" and isinstance(event.get("tool"), str)
    }
    exposed_paths = [
        event.get("path")
        for event in trajectory["events"]
        if event.get("type") in ("gold-read", "verifier-read")
    ]
    prohibited_actions = [
        event.get("action")
        for event in trajectory["events"]
        if event.get("type") == "action"
        and event.get("action") in task["prohibited_actions"]
    ]
    gates = evaluate_gates(
        {
            "schema_valid": True,
            "exposed_paths": exposed_paths,
            "expected_capability_hash": capability_hash,
            "actual_capability_hash": trajectory["infrastructure"]["capability_hash"],
            "fixture_hash_valid": True,
            "verifier_hash_valid": True,
            "prohibited_actions": prohibited_actions,
            "requested_tools": task["allowed_tools"],
            "matched_tools": sorted(invoked_tools),
            "infrastructure_failure": trajectory["infrastructure"]["failure"],
        },
        observation,
    )
    run_id = "run-offline-harness-self-test"
    score = score_from_verifier(
        run_id,
        verifier,
        {"diagnosis.txt": "quota-exceeded"},
        gates,
    )
    return {
        "contract_version": CONTRACT_VERSION,
        "kind": "harness-self-test",
        "case_id": case["case_id"],
        "model_claim": False,
        "countability": gates["status"],
        "score_hash": sha256_value(score),
    }
