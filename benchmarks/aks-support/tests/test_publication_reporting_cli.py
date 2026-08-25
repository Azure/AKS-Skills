from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aks_support_benchmark.contracts import CONTRACT_VERSION  # noqa: E402
from aks_support_benchmark.identity import sha256_value  # noqa: E402
from aks_support_benchmark.publication import (  # noqa: E402
    PublicationError,
    scan_package,
)
from aks_support_benchmark.reporting import (  # noqa: E402
    ResultStoreError,
    append_result,
    regenerate_report,
)
from aks_support_benchmark.strictjson import load  # noqa: E402


def result(result_id: str) -> dict:
    digest = "sha256:" + "0" * 64
    return {
        "contract_version": CONTRACT_VERSION,
        "kind": "result",
        "result_id": result_id,
        "run_id": f"run-{result_id}",
        "claim_id": "skill-effect",
        "mode": "direct-model-context",
        "manifest_hash": digest,
        "trajectory_hash": digest,
        "score_hash": digest,
        "countability": "countable",
        "comparison_outcome": "neutral",
    }


class PublicationTest(unittest.TestCase):
    def test_publication_scan_accepts_declared_safe_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "safe.json").write_text('{"public":true}\n', encoding="utf-8")
            scan_package(root, ["safe.json"])

    def test_publication_scan_fails_closed_on_unknown_extension(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "artifact.bin").write_bytes(b"safe-looking")
            with self.assertRaisesRegex(PublicationError, "unknown packaged extension"):
                scan_package(root, ["artifact.bin"])

    def test_publication_scan_rejects_sensitive_content(self) -> None:
        samples = {
            "secret.txt": "api_key=not-a-real-key",
            "path.txt": "/Users/example/private/results.json",
            "resource.txt": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/x",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, content in samples.items():
                (root / name).write_text(content, encoding="utf-8")
                with self.subTest(name=name), self.assertRaises(PublicationError):
                    scan_package(root, [name])

    def test_publication_scan_rejects_path_escape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(PublicationError):
                scan_package(root, ["../outside.txt"])


class ReportingTest(unittest.TestCase):
    def test_append_only_results_and_artifact_regeneration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "results.jsonl"
            first = result("one")
            expected_hash = append_result(path, first)
            with self.assertRaisesRegex(ResultStoreError, "already exists"):
                append_result(path, first)
            plan = load(ROOT / "contracts" / "claim-plan.json")
            report = regenerate_report(path, plan, "regenerated")
            self.assertEqual(report["result_hashes"], [expected_hash])
            self.assertEqual(report["status"], "descriptive-preliminary")
            self.assertEqual(report["rankings"], [])
            self.assertEqual(report, regenerate_report(path, plan, "regenerated"))


class CliIntegrationTest(unittest.TestCase):
    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(ROOT / "cli.py"), *args],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_cli_validates_canaries(self) -> None:
        completed = self.run_cli(
            "validate", str(ROOT / "fixtures" / "canary.json")
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout), {"cases": 2, "valid": True})

    def test_cli_runs_offline_smoke_without_model_claim(self) -> None:
        completed = self.run_cli(
            "self-test", "--offline", "--no-model"
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertFalse(payload["model_claim"])
        self.assertEqual(payload["countability"], "countable")


if __name__ == "__main__":
    unittest.main()
