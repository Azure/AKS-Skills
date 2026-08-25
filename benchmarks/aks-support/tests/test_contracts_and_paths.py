from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aks_support_benchmark.contracts import (  # noqa: E402
    CONTRACT_VERSION,
    ContractError,
    validate_contract,
)
from aks_support_benchmark.fixture import load_case  # noqa: E402
from aks_support_benchmark.paths import (  # noqa: E402
    PathSafetyError,
    confined_path,
    normalized_relative,
    require_disjoint,
    require_external,
)
from aks_support_benchmark.execution import validate_run_locations  # noqa: E402
from aks_support_benchmark.strictjson import StrictJSONError, loads  # noqa: E402


class StrictContractsTest(unittest.TestCase):
    def test_duplicate_key_rejected(self) -> None:
        with self.assertRaisesRegex(StrictJSONError, "duplicate JSON key"):
            loads('{"kind":"task","kind":"case"}')

    def test_unknown_contract_field_rejected(self) -> None:
        value = {
            "contract_version": CONTRACT_VERSION,
            "kind": "adapter-config",
            "adapter_id": "recorded",
            "adapter_type": "recorded",
            "allowed_env": [],
            "config": {},
            "surprise": True,
        }
        with self.assertRaisesRegex(ContractError, "unknown=\\['surprise'\\]"):
            validate_contract(value)

    def test_malformed_hash_rejected(self) -> None:
        value = {
            "contract_version": CONTRACT_VERSION,
            "kind": "result",
            "result_id": "r",
            "run_id": "run",
            "claim_id": "claim",
            "mode": "agent-folder",
            "manifest_hash": "latest",
            "trajectory_hash": "sha256:" + "0" * 64,
            "score_hash": "sha256:" + "0" * 64,
            "countability": "countable",
        }
        with self.assertRaisesRegex(ContractError, "invalid content hash"):
            validate_contract(value)

    def test_fixture_contracts_and_gold_are_isolated(self) -> None:
        fixtures = ROOT / "fixtures" / "public-canaries"
        for case_root in sorted(path.parent for path in fixtures.glob("*/case.json")):
            case, task, verifier = load_case(case_root)
            self.assertEqual(case["case_id"], task["case_id"])
            self.assertTrue(verifier["gold_files"])
            solver = (case_root / case["task_path"]).parent.resolve()
            verifier_root = (case_root / case["verifier_path"]).parent.resolve()
            self.assertFalse(verifier_root.is_relative_to(solver))


class PathSafetyTest(unittest.TestCase):
    def test_path_escape_and_non_normal_forms_rejected(self) -> None:
        for value in ("../gold.json", "/tmp/gold.json", "a/../gold.json", "a\\b"):
            with self.subTest(value=value), self.assertRaises(PathSafetyError):
                normalized_relative(value)

    def test_symlink_escape_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as root_dir, tempfile.TemporaryDirectory() as outside_dir:
            root = Path(root_dir)
            outside = Path(outside_dir)
            (outside / "gold.txt").write_text("secret", encoding="utf-8")
            os.symlink(outside, root / "link")
            with self.assertRaisesRegex(PathSafetyError, "symlink escapes"):
                confined_path(root, "link/gold.txt")

    def test_gold_workspace_overlap_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(PathSafetyError, "must be isolated"):
                require_disjoint(
                    ("solver workspace", root),
                    ("gold", root / "verifier"),
                )

    def test_private_root_under_repository_rejected(self) -> None:
        with self.assertRaisesRegex(PathSafetyError, "outside repository"):
            require_external(ROOT / "private-holdout", ROOT.parent.parent, "private")

    def test_result_root_under_repository_rejected(self) -> None:
        repo = ROOT.parent.parent
        with tempfile.TemporaryDirectory() as outside:
            with self.assertRaisesRegex(PathSafetyError, "result root"):
                validate_run_locations(
                    repo,
                    Path(outside) / "workspace",
                    Path(outside) / "verifier",
                    repo / "results",
                )


if __name__ == "__main__":
    unittest.main()
