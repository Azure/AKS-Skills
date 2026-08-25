from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent.parent
sys.path.insert(0, str(ROOT))

from aks_support_benchmark.calibration import (  # noqa: E402
    ACCEPTED_MANIFEST_PATH,
    ACCEPTED_ENTRIES_SHA256,
    PUBLIC_CANARY_CASE_IDS,
    SOURCE_COMMIT,
    build_calibration_matrix,
    build_solver_packet_pair,
    load_complete_skill_bundle,
    regenerate_complete_skill_bundle,
    validate_calibration_matrix,
)
from aks_support_benchmark.contracts import (  # noqa: E402
    CONTRACT_VERSION,
    COPILOT_EXECUTION_ENVIRONMENT,
    COPILOT_EXECUTION_TRACK,
    COPILOT_MODEL_IDS,
    ContractError,
    validate_contract,
)


class CalibrationIdentityTest(unittest.TestCase):
    def test_explicit_model_inventory_builds_exact_matrix(self) -> None:
        self.assertEqual(len(COPILOT_MODEL_IDS), 23)
        self.assertNotIn("auto", COPILOT_MODEL_IDS)
        cells = build_calibration_matrix()
        self.assertEqual(len(cells), 92)
        self.assertEqual(
            {
                (cell["model_id"], cell["case_id"], cell["skill_available"])
                for cell in cells
            },
            {
                (model_id, case_id, skill_available)
                for model_id in COPILOT_MODEL_IDS
                for case_id in PUBLIC_CANARY_CASE_IDS
                for skill_available in (False, True)
            },
        )
        self.assertEqual(
            {cell["mode"] for cell in cells}, {"direct-model-context"}
        )
        self.assertEqual(
            {cell["execution_track"] for cell in cells},
            {COPILOT_EXECUTION_TRACK},
        )
        self.assertEqual(
            {cell["execution_environment"] for cell in cells},
            {COPILOT_EXECUTION_ENVIRONMENT},
        )
        for field in ("cell_id", "fresh_context_id", "attempt_id"):
            self.assertEqual(len({cell[field] for cell in cells}), 92)

    def test_model_substitution_duplicates_and_drift_are_rejected(self) -> None:
        invalid = (
            ("auto", *COPILOT_MODEL_IDS[1:]),
            (*COPILOT_MODEL_IDS[:-1], COPILOT_MODEL_IDS[0]),
            (*COPILOT_MODEL_IDS[:-1], "unknown-model"),
            tuple(reversed(COPILOT_MODEL_IDS)),
        )
        for model_ids in invalid:
            with self.subTest(model_ids=model_ids), self.assertRaises(ContractError):
                build_calibration_matrix(model_ids)

        drifted = list(build_calibration_matrix())
        drifted[0] = {**drifted[0], "execution_track": "raw-model"}
        with self.assertRaisesRegex(ContractError, "identity drift"):
            validate_calibration_matrix(drifted)

    def test_direct_identity_extension_is_all_or_nothing(self) -> None:
        legacy = {
            "contract_version": CONTRACT_VERSION,
            "kind": "run-manifest",
            "run_id": "run",
            "release_id": "release",
            "mode": "direct-model-context",
            "pair_id": "pair",
            "skill_available": False,
            "repetition": 0,
            "seed": "fixed",
            "identities": {
                name: "sha256:" + "0" * 64
                for name in (
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
                )
            },
            "capability_profile": {},
            "budgets": {},
            "retry_policy": {},
        }
        validate_contract(legacy, "run-manifest")
        incomplete = {**legacy, "attempt_id": "attempt-one"}
        with self.assertRaisesRegex(ContractError, "identity is incomplete"):
            validate_contract(incomplete, "run-manifest")

    def test_attempt_outcome_distinguishes_capability_and_infrastructure(self) -> None:
        for outcome in (
            "completed",
            "permanent-capability",
            "transient-infrastructure",
        ):
            validate_contract(
                {
                    "contract_version": CONTRACT_VERSION,
                    "kind": "attempt-outcome",
                    "attempt_id": "attempt-one",
                    "cell_id": "cell-one",
                    "outcome_identity": outcome,
                    "detail": "recorded without substitution",
                }
            )
        with self.assertRaisesRegex(ContractError, "outcome identity"):
            validate_contract(
                {
                    "contract_version": CONTRACT_VERSION,
                    "kind": "attempt-outcome",
                    "attempt_id": "attempt-one",
                    "cell_id": "cell-one",
                    "outcome_identity": "retryable",
                    "detail": "ambiguous",
                }
            )


class CompleteBundleAndPacketTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bundle = regenerate_complete_skill_bundle(REPO_ROOT)

    def test_bundle_regenerates_from_exact_git_objects(self) -> None:
        self.assertEqual(self.bundle.source_commit, SOURCE_COMMIT)
        self.assertEqual(self.bundle.entries_digest, ACCEPTED_ENTRIES_SHA256)
        self.assertEqual(len(self.bundle.files), 46)
        self.assertTrue(
            all(
                item.source_entry["git_mode"] in ("100644", "100755")
                for item in self.bundle.files
            )
        )
        self.assertTrue(
            all(
                not item.logical_path.startswith(("skills/", "/", "../"))
                for item in self.bundle.files
            )
        )

    def test_only_accepted_manifest_can_authorize_skill_arm(self) -> None:
        if not ACCEPTED_MANIFEST_PATH.is_file():
            self.skipTest("accepted calibration manifest is external to the repository")
        bundle = load_complete_skill_bundle(REPO_ROOT)
        self.assertEqual(bundle.entries_digest, ACCEPTED_ENTRIES_SHA256)

    def test_packet_pair_shares_case_and_scaffold_and_only_skill_has_bundle(
        self,
    ) -> None:
        for case_name in ("dns-nsg-udp53", "quota-exceeded"):
            with self.subTest(case_name=case_name):
                case_root = ROOT / "fixtures" / "public-canaries" / case_name
                pair = build_solver_packet_pair(case_root, self.bundle)
                self.assertIs(pair.control.case_packet, pair.skill.case_packet)
                self.assertIs(pair.control.scaffold, pair.skill.scaffold)
                self.assertEqual(pair.control.skill_files, ())
                self.assertEqual(len(pair.skill.skill_files), 46)
                for actual, expected in zip(pair.skill.skill_files, self.bundle.files):
                    self.assertEqual(actual.content, expected.content)
                for packet in (pair.control, pair.skill):
                    exposed = packet.case_packet.lower() + packet.scaffold.lower()
                    for forbidden in (
                        b"verifier",
                        b"gold",
                        b"no-skill",
                        b"condition",
                        b"candidate",
                        str(REPO_ROOT).encode().lower(),
                    ):
                        self.assertNotIn(forbidden, exposed)

    def test_matrix_drift_does_not_mutate_canonical_cells(self) -> None:
        canonical = list(build_calibration_matrix())
        drifted = copy.deepcopy(canonical)
        drifted[-1]["attempt_id"] = canonical[0]["attempt_id"]
        with self.assertRaises(ContractError):
            validate_calibration_matrix(drifted)


if __name__ == "__main__":
    unittest.main()
