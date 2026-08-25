from __future__ import annotations

import json
import hashlib
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent.parent

import sys

sys.path.insert(0, str(ROOT))

from aks_support_benchmark.calibration import ACCEPTED_MANIFEST_PATH  # noqa: E402
from aks_support_benchmark.pipeline import (  # noqa: E402
    EXPECTED_BUNDLE_BYTES,
    build_calibration_plan,
    calibration_request_record,
    evaluate_preflight,
    ingest_and_seal_attempt,
    materialize_calibration_request,
    regenerate_pipeline_report,
)
from aks_support_benchmark.strictjson import canonical_bytes  # noqa: E402


@unittest.skipUnless(
    ACCEPTED_MANIFEST_PATH.is_file(),
    "accepted calibration manifest is external to the repository",
)
class CalibrationPipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixtures = ROOT / "fixtures" / "public-canaries"
        cls.plan = build_calibration_plan(REPO_ROOT, cls.fixtures)

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
        self, cell: dict, output: dict[str, str], context_id: str
    ) -> dict:
        request, _ = materialize_calibration_request(self.plan, cell["cell_id"])
        events = [
            {"sequence": 0, "category": "lifecycle", "name": "request.started"},
            {"sequence": 1, "category": "model", "name": "model.requested"},
            {"sequence": 2, "category": "model", "name": "model.observed"},
            {"sequence": 3, "category": "output", "name": "output.emitted"},
            {"sequence": 4, "category": "lifecycle", "name": "request.completed"},
        ]
        return {
            "protocol_version": "aks-support-one-shot/v1",
            "request_id": cell["attempt_id"],
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

    def test_plan_freezes_exact_bundle_matrix_and_paired_prompts(self) -> None:
        self.assertEqual(len(self.plan["cells"]), 92)
        self.assertEqual(self.plan["bundle"]["file_count"], 46)
        self.assertEqual(self.plan["bundle"]["byte_count"], EXPECTED_BUNDLE_BYTES)
        self.assertEqual(self.plan["blocked_modes"], ["agent-folder"])

        control, skill = self.cells()
        control_request, control_metadata = materialize_calibration_request(
            self.plan, control["cell_id"]
        )
        skill_request, skill_metadata = materialize_calibration_request(
            self.plan, skill["cell_id"]
        )
        self.assertEqual(control_metadata["pair_id"], skill_metadata["pair_id"])
        self.assertEqual(
            control_metadata["identity"]["packet_hash"],
            skill_metadata["identity"]["packet_hash"],
        )
        self.assertEqual(control_metadata["bundle_bytes"], 0)
        self.assertEqual(skill_metadata["bundle_bytes"], EXPECTED_BUNDLE_BYTES)
        self.assertLess(len(control_request.prompt), len(skill_request.prompt))
        record = calibration_request_record(self.plan, skill["cell_id"])
        self.assertEqual(record["host_payload"]["tools"], [])
        self.assertEqual(
            record["host_payload"]["context"], {"fresh": True, "persist": False}
        )

    def test_preflight_requires_real_complete_host_evidence(self) -> None:
        _, skill = self.cells()
        blocked = evaluate_preflight(self.plan, skill["cell_id"])
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
        proven = evaluate_preflight(self.plan, skill["cell_id"], response)
        self.assertEqual(proven["status"], "proven")
        self.assertEqual(proven["bundle_bytes"], EXPECTED_BUNDLE_BYTES)
        self.assertTrue(all(proven["proof"].values()))

        response["solver_metadata"]["input_bytes"] -= 1
        rejected = evaluate_preflight(self.plan, skill["cell_id"], response)
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


if __name__ == "__main__":
    unittest.main()
