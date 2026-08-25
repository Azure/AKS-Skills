from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aks_support_benchmark.adapters import (  # noqa: E402
    AdapterError,
    CommandAdapter,
    ManualAdapter,
    validate_future_host_config,
)
from aks_support_benchmark.execution import (  # noqa: E402
    ExecutionError,
    observed_skill_access,
    prepare_skill,
)
from aks_support_benchmark.identity import (  # noqa: E402
    bundle_hash,
    complete_file_manifest,
)
from aks_support_benchmark.strictjson import load  # noqa: E402


class ExecutionModeTest(unittest.TestCase):
    def setUp(self) -> None:
        bundle_root = ROOT / "fixtures" / "skill-bundle"
        self.manifest = load(bundle_root / "manifest.json")
        self.skill_root = bundle_root / "self-test-skill"

    def test_direct_mode_injects_explicit_bytes(self) -> None:
        prepared = prepare_skill(
            "direct-model-context",
            self.skill_root,
            self.manifest,
            ["SKILL.md"],
        )
        self.assertEqual([item["path"] for item in prepared["injected"]], ["SKILL.md"])
        self.assertIsNone(prepared["folder"])

    def test_agent_folder_registers_complete_bundle(self) -> None:
        prepared = prepare_skill(
            "agent-folder",
            self.skill_root,
            self.manifest,
            [],
        )
        self.assertEqual(prepared["injected"], [])
        self.assertEqual(Path(prepared["folder"]), self.skill_root.resolve())

    def test_agent_folder_rejects_unregistered_skill_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "SKILL.md").write_text("registered", encoding="utf-8")
            manifest = {
                "files": complete_file_manifest(root),
            }
            manifest["bundle_hash"] = bundle_hash(manifest["files"])
            (root / "extra.md").write_text("unregistered", encoding="utf-8")
            with self.assertRaisesRegex(ExecutionError, "complete skill folder"):
                prepare_skill("agent-folder", root, manifest, [])

    def test_missing_trace_is_explicit(self) -> None:
        observation = observed_skill_access(
            "agent-folder",
            {"events": []},
            {"SKILL.md", "references/checklist.md"},
        )
        self.assertFalse(observation["trace_available"])
        self.assertEqual(
            observation["missing"], ["SKILL.md", "references/checklist.md"]
        )

    def test_trace_records_read_and_invoked_files(self) -> None:
        observation = observed_skill_access(
            "agent-folder",
            {
                "events": [
                    {"type": "file-read", "path": "SKILL.md"},
                    {"type": "script-invoked", "path": "scripts/check.py"},
                ]
            },
            {"SKILL.md", "scripts/check.py"},
        )
        self.assertTrue(observation["trace_available"])
        self.assertEqual(observation["observed"], ["SKILL.md", "scripts/check.py"])


class AdapterTest(unittest.TestCase):
    def test_command_adapter_uses_structured_io_and_allowlisted_env(self) -> None:
        program = (
            "import json,sys;"
            "request=json.load(sys.stdin);"
            "json.dump({'seen':request['value']},sys.stdout)"
        )
        adapter = CommandAdapter([sys.executable, "-c", program], [], {})
        self.assertEqual(adapter.invoke({"value": "safe"}), {"seen": "safe"})

    def test_command_adapter_rejects_unallowlisted_environment(self) -> None:
        with self.assertRaisesRegex(ValueError, "not allowlisted"):
            CommandAdapter([sys.executable, "-c", "pass"], [], {"TOKEN": "secret"})

    def test_future_host_config_contains_names_not_endpoints(self) -> None:
        self.assertEqual(
            validate_future_host_config(
                {
                    "provider": "azure-openai",
                    "deployment_env": "AZURE_OPENAI_DEPLOYMENT",
                    "endpoint_env": "AZURE_OPENAI_ENDPOINT",
                }
            )["provider"],
            "azure-openai",
        )
        with self.assertRaisesRegex(AdapterError, "must not contain an endpoint"):
            validate_future_host_config(
                {
                    "provider": "openai-compatible",
                    "model_env": "MODEL",
                    "base_url_env": "https://example.invalid",
                }
            )

    def test_manual_adapter_requires_provenance(self) -> None:
        trajectory = load(
            ROOT
            / "fixtures"
            / "public-canaries"
            / "quota-exceeded"
            / "recorded"
            / "trajectory.json"
        )
        adapter = ManualAdapter(
            {
                "recorded_by": "controlled-host",
                "recorded_at": "2026-08-24T00:00:00Z",
                "trajectory": trajectory,
            }
        )
        self.assertEqual(adapter.invoke({})["trajectory_id"], trajectory["trajectory_id"])


if __name__ == "__main__":
    unittest.main()
