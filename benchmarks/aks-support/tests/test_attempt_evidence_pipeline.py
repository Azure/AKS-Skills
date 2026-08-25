from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aks_support_benchmark.attempts import (  # noqa: E402
    AttemptSealError,
    FailureClass,
    classify_failure,
    load_sealed_attempt,
    seal_attempt,
)
from aks_support_benchmark.contracts import CONTRACT_VERSION  # noqa: E402
from aks_support_benchmark.identity import sha256_value  # noqa: E402
from aks_support_benchmark.reporting import (  # noqa: E402
    calibration_report_bytes,
    regenerate_calibration_report,
)
from aks_support_benchmark.scoring import (  # noqa: E402
    compare_eligible_pair,
    score_eligible_attempt,
)
from aks_support_benchmark.validation import (  # noqa: E402
    evaluate_attempt_eligibility,
    evaluate_pair_eligibility,
)


ZERO = "sha256:" + "0" * 64
ONE = "sha256:" + "1" * 64
ACCEPTED_SHA = "4e6a54942cdde657d95bef28adf8d8e9ebcaa5f5"


def identity(
    condition: str = "skill",
    *,
    track: str = "raw",
    environment: str = "local",
) -> dict:
    return {
        "accepted_sha": ACCEPTED_SHA,
        "cell_id": "cell-one",
        "attempt_ordinal": 1,
        "attempt_nonce": "attempt-one",
        "mode": "direct-model-context",
        "execution_track": track,
        "environment": environment,
        "model": "approved-model",
        "fresh_context": True,
        "pair_id": "pair-one",
        "condition": condition,
        "packet_hash": ZERO,
        "scaffold_hash": ONE,
        "skill_hash": ONE if condition == "skill" else None,
    }


def write_attempt_source(
    root: Path,
    attempt_id: str,
    *,
    output: str = '{"answer":"quota"}',
    trace: dict | None = None,
    calibration_result: dict | None = None,
) -> Path:
    source = root / f"source-{attempt_id}"
    source.mkdir()
    (source / "output.json").write_text(output, encoding="utf-8")
    (source / "trace.json").write_text(
        json.dumps(
            trace
            if trace is not None
            else {"complete": True, "events": [], "tool_calls": []},
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    if calibration_result is not None:
        (source / "calibration-result.json").write_text(
            json.dumps(calibration_result, separators=(",", ":")),
            encoding="utf-8",
        )
    return source


def seal(
    root: Path,
    attempt_id: str,
    *,
    attempt_identity: dict | None = None,
    failure: FailureClass = FailureClass.NONE,
    output: str = '{"answer":"quota"}',
    trace: dict | None = None,
    calibration_result: dict | None = None,
) -> Path:
    source = write_attempt_source(
        root,
        attempt_id,
        output=output,
        trace=trace,
        calibration_result=calibration_result,
    )
    seals = root / "sealed"
    seal_attempt(
        source,
        seals,
        attempt_id,
        [attempt_id],
        attempt_identity or identity(),
        failure,
        required_artifacts=("output.json", "trace.json"),
    )
    return seals / attempt_id


def eligible(attempt_root: Path, expected: dict | None = None) -> dict:
    return evaluate_attempt_eligibility(
        attempt_root,
        expected_identity=expected or identity(),
        output_schema={"answer": str},
        leakage_markers=["VERIFIER-GOLD-CANARY"],
    )


def verifier() -> dict:
    return {
        "contract_version": CONTRACT_VERSION,
        "kind": "verifier",
        "verifier_id": "deterministic",
        "checks": [
            {
                "check_id": "root-cause",
                "type": "outcome_root_cause",
                "artifact": "answer",
                "expected": "quota",
            }
        ],
        "gold_files": [],
        "verifier_hash": ZERO,
    }


class AttemptSealingTest(unittest.TestCase):
    def test_attempts_are_write_once_and_each_id_retains_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = seal(root, "attempt-one")
            second = seal(root, "attempt-two")

            self.assertEqual(load_sealed_attempt(first)["attempt_id"], "attempt-one")
            self.assertEqual(load_sealed_attempt(second)["attempt_id"], "attempt-two")
            with self.assertRaisesRegex(AttemptSealError, "already sealed"):
                seal_attempt(
                    root / "source-attempt-one",
                    root / "sealed",
                    "attempt-one",
                    ["attempt-one"],
                    identity(),
                )

    def test_manifest_detects_artifact_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            attempt = seal(Path(directory), "tamper")
            (attempt / "artifacts" / "output.json").write_text(
                '{"answer":"changed"}', encoding="utf-8"
            )
            with self.assertRaisesRegex(
                AttemptSealError, "artifact manifest mismatch"
            ):
                load_sealed_attempt(attempt)

    def test_unregistered_attempt_id_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = write_attempt_source(root, "unexpected")
            with self.assertRaisesRegex(AttemptSealError, "not preregistered"):
                seal_attempt(
                    source,
                    root / "sealed",
                    "unexpected",
                    ["expected"],
                    identity(),
                )

    def test_failure_classification_separates_permanent_and_transient(self) -> None:
        self.assertEqual(
            classify_failure(model_capability_rejection=True),
            FailureClass.PERMANENT_MODEL_CAPABILITY_REJECTION,
        )
        transient = classify_failure(infrastructure_failure=True)
        self.assertEqual(transient, FailureClass.TRANSIENT_INFRASTRUCTURE_FAILURE)
        self.assertTrue(transient.retryable)
        self.assertFalse(
            FailureClass.PERMANENT_MODEL_CAPABILITY_REJECTION.retryable
        )
        with self.assertRaisesRegex(AttemptSealError, "ambiguous"):
            classify_failure(platform_failure=True, infrastructure_failure=True)


class AttemptEligibilityTest(unittest.TestCase):
    def test_complete_fresh_zero_tool_attempt_is_eligible(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = eligible(seal(Path(directory), "eligible"))
            self.assertEqual(result["status"], "eligible")
            self.assertTrue(all(result["gates"].values()))

    def test_strict_output_rejects_duplicate_unknown_and_missing_fields(self) -> None:
        samples = {
            "duplicate": '{"answer":"one","answer":"two"}',
            "unknown": '{"answer":"one","extra":true}',
            "missing": "{}",
            "malformed": '{"answer":',
        }
        for attempt_id, output in samples.items():
            with self.subTest(attempt_id=attempt_id), tempfile.TemporaryDirectory() as directory:
                result = eligible(seal(Path(directory), attempt_id, output=output))
                self.assertEqual(result["status"], "ineligible")
                self.assertFalse(result["gates"]["strict_json_schema"])

    def test_tool_event_and_unprovable_tool_absence_are_ineligible(self) -> None:
        traces = {
            "tool-event": {
                "complete": True,
                "events": [{"type": "tool-called", "tool": "shell"}],
                "tool_calls": [],
            },
            "missing-tool-proof": {"complete": True, "events": []},
        }
        for attempt_id, trace in traces.items():
            with self.subTest(attempt_id=attempt_id), tempfile.TemporaryDirectory() as directory:
                result = eligible(seal(Path(directory), attempt_id, trace=trace))
                self.assertEqual(result["status"], "ineligible")
                self.assertFalse(result["gates"]["zero_tool_calls"])

    def test_identity_drift_and_prompt_leakage_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            changed = identity()
            changed["environment"] = "different"
            attempt = seal(
                root,
                "drifted",
                attempt_identity=changed,
                output='{"answer":"VERIFIER-GOLD-CANARY"}',
            )
            result = eligible(attempt)
            self.assertFalse(result["gates"]["identity"])
            self.assertFalse(result["gates"]["prompt_leakage"])
            self.assertEqual(result["status"], "ineligible")

    def test_failure_status_preserves_retry_semantics(self) -> None:
        samples = {
            FailureClass.PERMANENT_MODEL_CAPABILITY_REJECTION: (
                "permanent-rejection",
                False,
            ),
            FailureClass.TRANSIENT_PLATFORM_FAILURE: ("transient-failure", True),
        }
        for failure, expected in samples.items():
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                result = eligible(
                    seal(Path(directory), failure.value, failure=failure)
                )
                self.assertEqual((result["status"], result["retryable"]), expected)


class PairScoringAndReportingTest(unittest.TestCase):
    def test_pair_equality_precedes_deterministic_scoring_and_comparison(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill_attempt = seal(root, "skill-attempt")
            no_skill_attempt = seal(
                root,
                "no-skill-attempt",
                attempt_identity=identity("no-skill"),
            )
            skill_eligibility = eligible(skill_attempt)
            no_skill_eligibility = eligible(
                no_skill_attempt, expected=identity("no-skill")
            )
            pair = evaluate_pair_eligibility(
                skill_attempt,
                no_skill_attempt,
                skill_eligibility,
                no_skill_eligibility,
            )
            self.assertEqual(pair["status"], "comparable")

            skill_score = score_eligible_attempt(
                "skill-run", verifier(), {"answer": "quota"}, skill_eligibility
            )
            no_skill_score = score_eligible_attempt(
                "no-skill-run",
                verifier(),
                {"answer": "wrong"},
                no_skill_eligibility,
            )
            self.assertEqual(
                compare_eligible_pair(pair, skill_score, no_skill_score), "positive"
            )
            self.assertNotIn("qualitative", skill_score)

    def test_packet_and_scaffold_mismatch_make_pair_ineligible(self) -> None:
        for field, gate in (
            ("packet_hash", "packet_equal"),
            ("scaffold_hash", "scaffold_equal"),
        ):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                changed = identity("no-skill")
                changed[field] = ZERO if changed[field] == ONE else ONE
                skill_attempt = seal(root, "skill-attempt")
                no_skill_attempt = seal(
                    root,
                    "no-skill-attempt",
                    attempt_identity=changed,
                )
                pair = evaluate_pair_eligibility(
                    skill_attempt,
                    no_skill_attempt,
                    eligible(skill_attempt),
                    eligible(no_skill_attempt, expected=changed),
                )
                self.assertEqual(pair["status"], "ineligible")
                self.assertFalse(pair["gates"][gate])

    def test_report_is_byte_identical_track_separated_and_descriptive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw_result = {
                "attempt_id": "raw-attempt",
                "claim_id": "skill-effect",
                "eligibility": "eligible",
                "score": {"outcome_root_cause": 1},
                "comparison_outcome": "positive",
            }
            copilot_result = {
                "attempt_id": "copilot-attempt",
                "claim_id": "skill-effect",
                "eligibility": "eligible",
                "score": {"outcome_root_cause": 0},
                "comparison_outcome": "negative",
            }
            raw = seal(
                root,
                "raw-attempt",
                calibration_result=raw_result,
            )
            copilot = seal(
                root,
                "copilot-attempt",
                attempt_identity=identity(track="copilot"),
                calibration_result=copilot_result,
            )
            staging_result = dict(raw_result, attempt_id="staging-attempt")
            staging = seal(
                root,
                "staging-attempt",
                attempt_identity=identity(environment="staging"),
                calibration_result=staging_result,
            )

            first = calibration_report_bytes([raw, copilot, staging], "calibration")
            second = calibration_report_bytes([staging, copilot, raw], "calibration")
            self.assertEqual(first, second)
            report = regenerate_calibration_report(
                [copilot, staging, raw], "calibration"
            )
            self.assertEqual(report["status"], "descriptive-pipeline-calibration")
            self.assertEqual(
                [
                    (item["execution_track"], item["environment"])
                    for item in report["partitions"]
                ],
                [("copilot", "local"), ("raw", "local"), ("raw", "staging")],
            )
            self.assertIn("no ranking", report["claim_boundary"])
            self.assertNotIn("rankings", report)


if __name__ == "__main__":
    unittest.main()
