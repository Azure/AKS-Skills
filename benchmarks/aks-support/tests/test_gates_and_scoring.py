from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aks_support_benchmark.contracts import CONTRACT_VERSION  # noqa: E402
from aks_support_benchmark.scoring import compare_pair  # noqa: E402
from aks_support_benchmark.validation import evaluate_gates  # noqa: E402


def gate_artifacts() -> dict:
    return {
        "schema_valid": True,
        "exposed_paths": [],
        "expected_capability_hash": "same",
        "actual_capability_hash": "same",
        "fixture_hash_valid": True,
        "verifier_hash_valid": True,
        "prohibited_actions": [],
        "requested_tools": ["read"],
        "matched_tools": ["read"],
        "infrastructure_failure": False,
    }


def manifest(skill: bool, mode: str = "agent-folder") -> dict:
    zero = "sha256:" + "0" * 64
    one = "sha256:" + "1" * 64
    identities = {
        name: zero
        for name in (
            "benchmark",
            "task",
            "environment",
            "verifier",
            "model",
            "scaffold",
            "prompt",
            "tools",
            "budget",
            "retry",
        )
    }
    identities["skill"] = one if skill else zero
    return {
        "contract_version": CONTRACT_VERSION,
        "kind": "run-manifest",
        "run_id": "skill" if skill else "no-skill",
        "release_id": "release",
        "mode": mode,
        "pair_id": "pair",
        "skill_available": skill,
        "repetition": 0,
        "seed": "seed",
        "identities": identities,
        "capability_profile": {"hash": zero},
        "budgets": {},
        "retry_policy": {},
    }


def score(run_id: str, total: int, status: str = "countable") -> dict:
    names = (
        "outcome_root_cause",
        "decisive_evidence",
        "distractor_rejection",
        "routing_escalation",
        "safe_remediation",
        "communication_uncertainty",
        "tool_efficiency",
        "infrastructure_status",
    )
    return {
        "contract_version": CONTRACT_VERSION,
        "kind": "score-vector",
        "score_id": f"score-{run_id}",
        "run_id": run_id,
        "countability": status,
        "dimensions": {name: int(index < total) for index, name in enumerate(names)},
        "evidence": [],
    }


class CountabilityGateTest(unittest.TestCase):
    def test_healthy_artifacts_are_countable(self) -> None:
        result = evaluate_gates(gate_artifacts(), {"trace_available": True})
        self.assertEqual(result["status"], "countable")

    def test_infrastructure_failure_is_uncountable(self) -> None:
        artifacts = gate_artifacts()
        artifacts["infrastructure_failure"] = True
        result = evaluate_gates(artifacts, {"trace_available": True})
        self.assertEqual(result["status"], "uncountable")
        self.assertEqual(result["reasons"], ["infrastructure_healthy"])

    def test_contamination_is_non_attributable(self) -> None:
        artifacts = gate_artifacts()
        artifacts["exposed_paths"] = ["verifier/answer.txt"]
        result = evaluate_gates(artifacts, {"trace_available": True})
        self.assertEqual(result["status"], "non-attributable")
        self.assertIn("contamination_clear", result["reasons"])

    def test_missing_trace_is_non_attributable(self) -> None:
        result = evaluate_gates(gate_artifacts(), {"trace_available": False})
        self.assertEqual(result["status"], "non-attributable")
        self.assertIn("trace_available", result["reasons"])

    def test_prohibited_action_is_non_attributable(self) -> None:
        artifacts = gate_artifacts()
        artifacts["prohibited_actions"] = ["mutate-cloud-resource"]
        result = evaluate_gates(artifacts, {"trace_available": True})
        self.assertEqual(result["status"], "non-attributable")
        self.assertIn("prohibited_actions_clear", result["reasons"])

    def test_unmatched_tool_is_non_attributable(self) -> None:
        artifacts = gate_artifacts()
        artifacts["matched_tools"] = []
        result = evaluate_gates(artifacts, {"trace_available": True})
        self.assertEqual(result["status"], "non-attributable")
        self.assertIn("tools_matched", result["reasons"])

    def test_integrity_and_capability_failures_are_non_attributable(self) -> None:
        mutations = {
            "schema_integrity": ("schema_valid", False),
            "capability_equivalent": ("actual_capability_hash", "different"),
            "fixture_verifier_integrity": ("fixture_hash_valid", False),
            "verifier-integrity": ("verifier_hash_valid", False),
        }
        for label, (field, value) in mutations.items():
            with self.subTest(label=label):
                artifacts = gate_artifacts()
                artifacts[field] = value
                result = evaluate_gates(artifacts, {"trace_available": True})
                self.assertEqual(result["status"], "non-attributable")


class PairedScoringTest(unittest.TestCase):
    def test_positive_skill_comparison_is_artifact_derived(self) -> None:
        outcome = compare_pair(
            manifest(True),
            manifest(False),
            score("skill", 6),
            score("no-skill", 3),
        )
        self.assertEqual(outcome, "positive")

    def test_neutral_skill_comparison_is_artifact_derived(self) -> None:
        outcome = compare_pair(
            manifest(True),
            manifest(False),
            score("skill", 4),
            score("no-skill", 4),
        )
        self.assertEqual(outcome, "neutral")

    def test_negative_skill_comparison_is_artifact_derived(self) -> None:
        outcome = compare_pair(
            manifest(True),
            manifest(False),
            score("skill", 2),
            score("no-skill", 5),
        )
        self.assertEqual(outcome, "negative")

    def test_uncountable_infrastructure_propagates(self) -> None:
        outcome = compare_pair(
            manifest(True),
            manifest(False),
            score("skill", 5, "uncountable"),
            score("no-skill", 5),
        )
        self.assertEqual(outcome, "uncountable")

    def test_non_attributable_propagates(self) -> None:
        outcome = compare_pair(
            manifest(True),
            manifest(False),
            score("skill", 5, "non-attributable"),
            score("no-skill", 5),
        )
        self.assertEqual(outcome, "non-attributable")

    def test_cohort_mismatch_rejected(self) -> None:
        changed = manifest(False)
        changed["seed"] = "different"
        with self.assertRaisesRegex(ValueError, "cohort mismatch: seed"):
            compare_pair(
                manifest(True),
                changed,
                score("skill", 5),
                score("no-skill", 5),
            )

    def test_cross_mode_scores_rejected(self) -> None:
        no_skill = manifest(False, mode="direct-model-context")
        with self.assertRaisesRegex(ValueError, "cohort mismatch: mode"):
            compare_pair(
                manifest(True),
                no_skill,
                score("skill", 5),
                score("no-skill", 5),
            )


if __name__ == "__main__":
    unittest.main()
