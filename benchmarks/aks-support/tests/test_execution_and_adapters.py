from __future__ import annotations

import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aks_support_benchmark.adapters import (  # noqa: E402
    AdapterError,
    CommandAdapter,
    ManualAdapter,
    invoke_one_shot,
    validate_future_host_config,
)
from aks_support_benchmark.execution import (  # noqa: E402
    ExecutionError,
    observed_skill_access,
    prepare_one_shot_request,
    prepare_skill,
)
from aks_support_benchmark.identity import (  # noqa: E402
    bundle_hash,
    complete_file_manifest,
    sha256_value,
)
from aks_support_benchmark.one_shot import (  # noqa: E402
    ONE_SHOT_PROTOCOL_VERSION,
    OneShotProtocolError,
    OutcomeStatus,
    validate_distinct_contexts,
    validate_distinct_requests,
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

    def test_command_adapter_does_not_expose_stderr(self) -> None:
        program = "import sys;sys.stderr.write('secret stderr');raise SystemExit(2)"
        adapter = CommandAdapter([sys.executable, "-c", program], [], {})
        with self.assertRaisesRegex(AdapterError, "status 2") as raised:
            adapter.invoke({})
        self.assertNotIn("secret stderr", str(raised.exception))

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


class StaticOneShotAdapter:
    def __init__(self, response: dict[str, object]) -> None:
        self.response = response
        self.request: dict[str, object] | None = None

    def invoke(self, request: dict[str, object]) -> dict[str, object]:
        self.request = request
        return self.response


class FailedOneShotAdapter:
    def invoke(self, request: dict[str, object]) -> dict[str, object]:
        del request
        raise AdapterError("unsafe adapter detail")


class OneShotExecutionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.case_root = ROOT / "fixtures" / "public-canaries" / "quota-exceeded"
        self.task = load(self.case_root / "solver" / "task.json")
        self.workspace_root = self.case_root / "solver"
        self.model = "candidate-model-version"
        self.capability_hash = sha256_value({"tools": []})
        self.request = prepare_one_shot_request(
            "cell-001",
            self.model,
            self.capability_hash,
            "Return only the final support response.",
            self.task,
            self.workspace_root,
        )

    def response(self) -> dict[str, object]:
        events = [
            {"sequence": 0, "category": "lifecycle", "name": "request.started"},
            {"sequence": 1, "category": "model", "name": "model.requested"},
            {"sequence": 2, "category": "model", "name": "model.observed"},
            {"sequence": 3, "category": "output", "name": "output.emitted"},
            {"sequence": 4, "category": "lifecycle", "name": "request.completed"},
        ]
        return {
            "protocol_version": ONE_SHOT_PROTOCOL_VERSION,
            "request_id": self.request.request_id,
            "requested_model": self.model,
            "observed_model": self.model,
            "output": {
                "content_type": "text/plain",
                "content": "The quota is exhausted; request quota before retrying.",
            },
            "events": events,
            "trace": {"complete": True, "event_count": len(events)},
            "solver_metadata": {
                "mode": "direct-model-context",
                "execution_track": "copilot-agent",
                "execution_environment": "github-copilot-subagent",
                "context_id": "context-001",
                "fresh_context": True,
                "input_message_count": 1,
                "prior_message_count": 0,
            },
            "failure": None,
        }

    def test_request_is_fresh_prompt_only_and_omits_control_metadata(self) -> None:
        payload = self.request.host_payload()
        self.assertEqual(len(payload["input"]["messages"]), 1)
        self.assertEqual(payload["input"]["messages"][0]["role"], "user")
        self.assertEqual(payload["context"], {"fresh": True, "persist": False})
        self.assertEqual(payload["tools"], [])
        prompt = payload["input"]["messages"][0]["content"]
        self.assertNotIn(self.model, prompt)
        self.assertNotIn(str(self.case_root), prompt)
        self.assertNotIn(self.task["case_id"], prompt)
        self.assertNotIn("verifier", prompt.lower())
        self.assertNotIn("condition", prompt.lower())

        second = prepare_one_shot_request(
            "cell-002",
            self.model,
            self.capability_hash,
            "Return only the final support response.",
            self.task,
            self.workspace_root,
        )
        validate_distinct_requests([self.request, second])
        with self.assertRaisesRegex(OneShotProtocolError, "distinct"):
            validate_distinct_requests([self.request, self.request])

    def test_request_includes_frozen_skill_bytes_without_arm_label(self) -> None:
        bundle_root = ROOT / "fixtures" / "skill-bundle"
        manifest = load(bundle_root / "manifest.json")
        skill_root = bundle_root / "self-test-skill"
        prepared = prepare_skill(
            "direct-model-context", skill_root, manifest, ["SKILL.md"]
        )
        request = prepare_one_shot_request(
            "cell-skill-001",
            self.model,
            self.capability_hash,
            "Return only the final support response.",
            self.task,
            self.workspace_root,
            prepared["injected"],
        )
        prompt = request.host_payload()["input"]["messages"][0]["content"]
        self.assertIn(prepared["injected"][0]["bytes_base64"], prompt)
        self.assertNotIn("skill arm", prompt.lower())
        self.assertNotIn("condition", prompt.lower())

    def test_valid_complete_zero_tool_trace_is_eligible(self) -> None:
        adapter = StaticOneShotAdapter(self.response())
        outcome = invoke_one_shot(adapter, self.request)
        self.assertTrue(outcome.eligible)
        self.assertEqual(outcome.status, OutcomeStatus.ELIGIBLE)
        self.assertEqual(outcome.observed_model, self.model)
        self.assertEqual(outcome.trajectory()["infrastructure"]["network_called"], False)
        self.assertEqual(adapter.request, self.request.host_payload())

    def test_tool_event_is_permanently_rejected(self) -> None:
        response = self.response()
        events = response["events"]
        events.insert(
            3, {"sequence": 3, "category": "tool", "name": "tool.invoked"}
        )
        for sequence, event in enumerate(events):
            event["sequence"] = sequence
        response["trace"]["event_count"] = len(events)
        outcome = invoke_one_shot(StaticOneShotAdapter(response), self.request)
        self.assertFalse(outcome.eligible)
        self.assertEqual(
            outcome.status, OutcomeStatus.PERMANENT_CAPABILITY_REJECTION
        )
        self.assertEqual(outcome.failure.code, "prohibited-invocation")

    def test_incomplete_trace_is_transient_failure(self) -> None:
        response = self.response()
        response["trace"]["complete"] = False
        outcome = invoke_one_shot(StaticOneShotAdapter(response), self.request)
        self.assertEqual(
            outcome.status, OutcomeStatus.TRANSIENT_INFRASTRUCTURE_FAILURE
        )
        self.assertEqual(outcome.failure.code, "trace-incomplete")

    def test_adapter_failure_is_sanitized_transient_evidence(self) -> None:
        outcome = invoke_one_shot(FailedOneShotAdapter(), self.request)
        self.assertEqual(
            outcome.status, OutcomeStatus.TRANSIENT_INFRASTRUCTURE_FAILURE
        )
        self.assertEqual(outcome.failure.code, "adapter-transport-failure")
        self.assertNotIn("unsafe adapter detail", outcome.failure.message)

    def test_model_mismatch_is_permanently_rejected(self) -> None:
        response = self.response()
        response["observed_model"] = "different-model-version"
        outcome = invoke_one_shot(StaticOneShotAdapter(response), self.request)
        self.assertEqual(
            outcome.status, OutcomeStatus.PERMANENT_CAPABILITY_REJECTION
        )
        self.assertEqual(outcome.failure.code, "model-identity-mismatch")

    def test_malformed_output_is_permanently_rejected(self) -> None:
        response = self.response()
        response["output"] = {"content_type": "text/plain", "content": ""}
        outcome = invoke_one_shot(StaticOneShotAdapter(response), self.request)
        self.assertEqual(
            outcome.status, OutcomeStatus.PERMANENT_CAPABILITY_REJECTION
        )
        self.assertEqual(outcome.failure.code, "malformed-output")

    def test_solver_metadata_rejects_prohibited_fields(self) -> None:
        response = self.response()
        response["solver_metadata"]["condition"] = "skill"
        outcome = invoke_one_shot(StaticOneShotAdapter(response), self.request)
        self.assertEqual(outcome.failure.code, "solver-metadata-rejected")

    def test_safe_platform_failure_is_preserved_without_raw_body(self) -> None:
        response = self.response()
        response["observed_model"] = None
        response["output"] = None
        response["events"][-1]["name"] = "request.failed"
        response["failure"] = {
            "status": "transient-infrastructure-failure",
            "code": "service-unavailable",
            "message": "The service is temporarily unavailable.",
        }
        outcome = invoke_one_shot(StaticOneShotAdapter(response), self.request)
        self.assertEqual(
            outcome.failure.as_dict(),
            {
                "status": "transient-infrastructure-failure",
                "code": "service-unavailable",
                "message": "The service is temporarily unavailable.",
            },
        )

        unsafe = deepcopy(response)
        unsafe["failure"]["message"] = "endpoint=https://private.invalid"
        rejected = invoke_one_shot(StaticOneShotAdapter(unsafe), self.request)
        self.assertEqual(rejected.failure.code, "unsafe-failure-evidence")
        self.assertNotIn("private.invalid", rejected.failure.message)

    def test_context_reuse_is_rejected_across_cells(self) -> None:
        first = invoke_one_shot(StaticOneShotAdapter(self.response()), self.request)
        second_request = prepare_one_shot_request(
            "cell-002",
            self.model,
            self.capability_hash,
            "Return only the final support response.",
            self.task,
            self.workspace_root,
        )
        second_response = self.response()
        second_response["request_id"] = second_request.request_id
        second = invoke_one_shot(StaticOneShotAdapter(second_response), second_request)
        with self.assertRaisesRegex(OneShotProtocolError, "reused"):
            validate_distinct_contexts([first, second])


if __name__ == "__main__":
    unittest.main()
