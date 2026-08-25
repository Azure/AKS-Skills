from __future__ import annotations

import json
import hashlib
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent.parent

import sys

sys.path.insert(0, str(ROOT))

from aks_support_benchmark.attempts import load_sealed_attempt  # noqa: E402
from aks_support_benchmark.calibration import (  # noqa: E402
    regenerate_complete_skill_bundle,
)
from aks_support_benchmark.pipeline import (  # noqa: E402
    EXPECTED_BUNDLE_BYTES,
    CalibrationPipelineError,
    build_calibration_plan,
    calibration_request_record,
    evaluate_preflight,
    ingest_and_seal_attempt,
    materialize_calibration_request,
    regenerate_pipeline_report,
)
from aks_support_benchmark.strictjson import canonical_bytes  # noqa: E402
from aks_support_benchmark.publication import scan_file  # noqa: E402


class CalibrationPipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixtures = ROOT / "fixtures" / "public-canaries"
        cls.nonces = ("attempt-one", "attempt-two")
        bundle = regenerate_complete_skill_bundle(REPO_ROOT)
        with patch(
            "aks_support_benchmark.pipeline.load_complete_skill_bundle",
            return_value=bundle,
        ):
            cls.plan = build_calibration_plan(
                REPO_ROOT,
                cls.fixtures,
                Path("explicit-manifest.json"),
                cls.nonces,
            )

    def cells(self) -> tuple[dict, dict]:
        matching = [
            cell
            for cell in self.plan["cells"]
            if cell["model_id"] == "gpt-5.6-sol"
            and cell["case_id"] == "public-canary-quota-exceeded"
        ]
        return (
            next(cell for cell in matching if not cell["skill_available"]),
            next(cell for cell in matching if cell["skill_available"]),
        )

    def response(
        self,
        cell: dict,
        output: dict[str, str],
        context_id: str,
        attempt_nonce: str = "attempt-one",
    ) -> dict:
        request, _ = materialize_calibration_request(
            self.plan, cell["cell_id"], attempt_nonce
        )
        events = [
            {"sequence": 0, "category": "lifecycle", "name": "request.started"},
            {"sequence": 1, "category": "model", "name": "model.requested"},
            {"sequence": 2, "category": "model", "name": "model.observed"},
            {"sequence": 3, "category": "output", "name": "output.emitted"},
            {"sequence": 4, "category": "lifecycle", "name": "request.completed"},
        ]
        return {
            "protocol_version": "aks-support-one-shot/v1",
            "request_id": request.request_id,
            "requested_model": cell["model_id"],
            "observed_model": cell["model_id"],
            "output": {
                "content_type": "text/plain",
                "content": canonical_bytes(output).decode("ascii"),
            },
            "events": events,
            "trace": {"complete": True, "event_count": len(events)},
            "solver_metadata": {
                "mode": "direct-model-context",
                "execution_track": "copilot-agent",
                "execution_environment": "github-copilot-subagent",
                "context_id": context_id,
                "fresh_context": True,
                "input_message_count": 1,
                "prior_message_count": 0,
                "input_bytes": len(request.prompt.encode("utf-8")),
                "input_sha256": (
                    "sha256:"
                    + hashlib.sha256(request.prompt.encode("utf-8")).hexdigest()
                ),
            },
            "failure": None,
        }

    def failure_response(
        self,
        cell: dict,
        context_id: str,
        status: str,
        code: str,
        attempt_nonce: str = "attempt-one",
    ) -> dict:
        response = self.response(
            cell, {"diagnosis.txt": "unused"}, context_id, attempt_nonce
        )
        response["observed_model"] = None
        response["output"] = None
        response["events"] = [
            {"sequence": 0, "category": "lifecycle", "name": "request.started"},
            {"sequence": 1, "category": "lifecycle", "name": "request.failed"},
        ]
        response["trace"]["event_count"] = 2
        response["failure"] = {
            "status": status,
            "code": code,
            "message": "The host returned a classified failure.",
        }
        return response

    def test_plan_freezes_exact_bundle_matrix_and_paired_prompts(self) -> None:
        self.assertEqual(len(self.plan["cells"]), 92)
        self.assertEqual(self.plan["bundle"]["file_count"], 46)
        self.assertEqual(self.plan["bundle"]["byte_count"], EXPECTED_BUNDLE_BYTES)
        self.assertEqual(self.plan["blocked_modes"], ["agent-folder"])
        self.assertEqual(self.plan["attempt_nonces"], list(self.nonces))
        self.assertEqual(len(self.plan["attempts"]), 184)

        control, skill = self.cells()
        control_request, control_metadata = materialize_calibration_request(
            self.plan, control["cell_id"], "attempt-one"
        )
        skill_request, skill_metadata = materialize_calibration_request(
            self.plan, skill["cell_id"], "attempt-one"
        )
        self.assertEqual(control_metadata["pair_id"], skill_metadata["pair_id"])
        self.assertEqual(
            control_metadata["identity"]["packet_hash"],
            skill_metadata["identity"]["packet_hash"],
        )
        self.assertEqual(control_metadata["bundle_bytes"], 0)
        self.assertEqual(skill_metadata["bundle_bytes"], EXPECTED_BUNDLE_BYTES)
        self.assertLess(len(control_request.prompt), len(skill_request.prompt))
        record = calibration_request_record(
            self.plan, skill["cell_id"], "attempt-one"
        )
        self.assertEqual(record["host_payload"]["tools"], [])
        self.assertEqual(
            record["host_payload"]["context"], {"fresh": True, "persist": False}
        )

    def test_publishable_source_has_no_private_path_and_cli_requires_manifest(
        self,
    ) -> None:
        source = ROOT / "aks_support_benchmark" / "calibration.py"
        text = source.read_text(encoding="utf-8")
        self.assertNotIn("/Users/", text)
        self.assertIsNone(
            re.search(
                r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
                r"[89ab][0-9a-f]{3}-[0-9a-f]{12}\b",
                text,
            )
        )
        self.assertEqual(scan_file(source), [])

        with tempfile.TemporaryDirectory() as directory:
            completed = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "cli.py"),
                    "calibration-prepare",
                    "--repo-root",
                    str(REPO_ROOT),
                    "--fixtures",
                    str(self.fixtures),
                    "--attempt-nonce",
                    "attempt-one",
                    "--output",
                    str(Path(directory) / "plan.json"),
                ],
                text=True,
                capture_output=True,
                check=False,
            )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("--accepted-manifest", completed.stderr)

    def test_preflight_requires_real_complete_host_evidence(self) -> None:
        _, skill = self.cells()
        blocked = evaluate_preflight(
            self.plan, skill["cell_id"], "attempt-one"
        )
        self.assertEqual(blocked["status"], "blocked-unproven")
        self.assertFalse(any(blocked["proof"].values()))

        response = self.response(
            skill,
            {
                "diagnosis.txt": "quota-exceeded",
                "evidence.txt": "regional vCPU quota is exhausted",
                "mutation.txt": "none",
                "uncertainty.txt": "none",
            },
            "preflight-context",
        )
        proven = evaluate_preflight(
            self.plan, skill["cell_id"], "attempt-one", response
        )
        self.assertEqual(proven["status"], "proven")
        self.assertEqual(proven["bundle_bytes"], EXPECTED_BUNDLE_BYTES)
        self.assertTrue(all(proven["proof"].values()))

        response["solver_metadata"]["input_bytes"] -= 1
        rejected = evaluate_preflight(
            self.plan, skill["cell_id"], "attempt-one", response
        )
        self.assertEqual(rejected["status"], "blocked-unproven")
        self.assertEqual(rejected["failure"]["code"], "solver-metadata-rejected")

    def test_sealed_pair_gates_scores_compares_and_reports(self) -> None:
        control, skill = self.cells()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging = root / "staging"
            seals = root / "seals"
            common = {
                "evidence.txt": "regional vCPU quota is exhausted",
                "mutation.txt": "none",
                "uncertainty.txt": "none",
            }
            ingest_and_seal_attempt(
                self.plan,
                control["cell_id"],
                "attempt-one",
                self.response(
                    control,
                    {"diagnosis.txt": "unknown", **common},
                    "control-context",
                ),
                staging,
                seals,
            )
            ingest_and_seal_attempt(
                self.plan,
                skill["cell_id"],
                "attempt-one",
                self.response(
                    skill,
                    {"diagnosis.txt": "quota-exceeded", **common},
                    "skill-context",
                ),
                staging,
                seals,
            )

            report = regenerate_pipeline_report(
                self.plan, seals, self.fixtures, "pipeline-calibration"
            )
            self.assertEqual(report["status"], "descriptive-pipeline-calibration")
            self.assertEqual(len(report["partitions"]), 1)
            observations = report["partitions"][0]["observations"]
            self.assertEqual(len(observations), 2)
            self.assertEqual(
                {item["comparison_outcome"] for item in observations}, {"positive"}
            )
            self.assertNotIn("rankings", report)
            for prohibited in (
                "ranking",
                "uplift",
                "superiority",
                "confidence",
                "skill-effect",
                "product-quality",
            ):
                self.assertIn(prohibited, report["claim_boundary"])

    def test_reused_observed_context_blocks_pair_comparison(self) -> None:
        control, skill = self.cells()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging = root / "staging"
            seals = root / "seals"
            output = {
                "diagnosis.txt": "quota-exceeded",
                "evidence.txt": "regional vCPU quota is exhausted",
                "mutation.txt": "none",
                "uncertainty.txt": "none",
            }
            for cell in (control, skill):
                ingest_and_seal_attempt(
                    self.plan,
                    cell["cell_id"],
                    "attempt-one",
                    self.response(cell, output, "reused-context"),
                    staging,
                    seals,
                )
            report = regenerate_pipeline_report(
                self.plan, seals, self.fixtures, "reused-context"
            )
            observations = report["partitions"][0]["observations"]
            self.assertEqual(
                {item["eligibility"] for item in observations}, {"ineligible"}
            )
            self.assertEqual(
                {item["comparison_outcome"] for item in observations}, {None}
            )

    def test_transient_attempt_is_retained_and_successful_retry_is_selected(
        self,
    ) -> None:
        control, skill = self.cells()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging = root / "staging"
            seals = root / "seals"
            common = {
                "evidence.txt": "regional vCPU quota is exhausted",
                "mutation.txt": "none",
                "uncertainty.txt": "none",
            }
            sealed: list[Path] = []
            for cell in (control, skill):
                sealed.append(
                    ingest_and_seal_attempt(
                        self.plan,
                        cell["cell_id"],
                        "attempt-one",
                        self.failure_response(
                            cell,
                            f"{cell['cell_id']}-transient",
                            "transient-infrastructure-failure",
                            "service-unavailable",
                        ),
                        staging,
                        seals,
                    )
                )
                sealed.append(
                    ingest_and_seal_attempt(
                        self.plan,
                        cell["cell_id"],
                        "attempt-two",
                        self.response(
                            cell,
                            {
                                "diagnosis.txt": (
                                    "quota-exceeded"
                                    if cell["skill_available"]
                                    else "unknown"
                                ),
                                **common,
                            },
                            f"{cell['cell_id']}-success",
                            "attempt-two",
                        ),
                        staging,
                        seals,
                    )
                )

            self.assertEqual(
                [load_sealed_attempt(path)["attempt_id"] for path in sealed],
                [path.name for path in sealed],
            )
            report = regenerate_pipeline_report(
                self.plan, seals, self.fixtures, "retry-sequence"
            )
            observations = report["partitions"][0]["observations"]
            self.assertEqual(len(observations), 4)
            first = [
                item for item in observations if item["attempt_ordinal"] == 1
            ]
            second = [
                item for item in observations if item["attempt_ordinal"] == 2
            ]
            self.assertEqual(
                {item["eligibility"] for item in first}, {"transient-failure"}
            )
            self.assertFalse(any(item["selected_for_comparison"] for item in first))
            self.assertEqual({item["eligibility"] for item in second}, {"eligible"})
            self.assertTrue(all(item["selected_for_comparison"] for item in second))
            self.assertEqual(
                {item["comparison_outcome"] for item in second}, {"positive"}
            )

    def test_permanent_capability_attempt_is_terminal_and_distinct(self) -> None:
        _, skill = self.cells()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging = root / "staging"
            seals = root / "seals"
            ingest_and_seal_attempt(
                self.plan,
                skill["cell_id"],
                "attempt-one",
                self.failure_response(
                    skill,
                    "permanent-context",
                    "permanent-capability-rejection",
                    "model-unavailable",
                ),
                staging,
                seals,
            )
            with self.assertRaisesRegex(
                CalibrationPipelineError, "retryable predecessor"
            ):
                ingest_and_seal_attempt(
                    self.plan,
                    skill["cell_id"],
                    "attempt-two",
                    self.response(
                        skill,
                        {
                            "diagnosis.txt": "quota-exceeded",
                            "evidence.txt": "quota",
                            "mutation.txt": "none",
                            "uncertainty.txt": "none",
                        },
                        "should-not-run",
                        "attempt-two",
                    ),
                    staging,
                    seals,
                )
            report = regenerate_pipeline_report(
                self.plan, seals, self.fixtures, "permanent"
            )
            observation = report["partitions"][0]["observations"][0]
            self.assertEqual(observation["eligibility"], "permanent-rejection")
            self.assertTrue(observation["terminal"])
            self.assertFalse(observation["selected_for_comparison"])


if __name__ == "__main__":
    unittest.main()
