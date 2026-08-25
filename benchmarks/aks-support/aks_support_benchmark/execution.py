"""Execution-mode preparation and skill-observation checks."""

from __future__ import annotations

import base64
import binascii
import json
from pathlib import Path
from typing import Any

from .contracts import validate_contract
from .identity import complete_file_manifest, sha256_bytes
from .one_shot import OneShotRequest, validate_request_fields
from .paths import confined_path, require_disjoint, require_external


class ExecutionError(ValueError):
    """Raised when an execution mode is incomplete or ambiguous."""


def validate_run_locations(
    repo_root: Path,
    solver_workspace: Path,
    verifier_root: Path,
    result_root: Path,
    private_holdout_root: Path | None = None,
) -> None:
    require_external(result_root, repo_root, "result root")
    named = [
        ("solver workspace", solver_workspace),
        ("verifier root", verifier_root),
        ("result root", result_root),
    ]
    if private_holdout_root is not None:
        require_external(private_holdout_root, repo_root, "private holdout root")
        named.append(("private holdout root", private_holdout_root))
    require_disjoint(*named)


def prepare_skill(
    mode: str, skill_root: Path, manifest: dict[str, Any], selected_files: list[str]
) -> dict[str, Any]:
    registered = {entry["path"]: entry for entry in manifest["files"]}
    if mode == "direct-model-context":
        if not selected_files:
            raise ExecutionError("direct-model-context requires explicit selected files")
        injected: list[dict[str, Any]] = []
        for relative in selected_files:
            if relative not in registered:
                raise ExecutionError(f"selected file is not in skill bundle: {relative}")
            content = confined_path(skill_root, relative).read_bytes()
            if sha256_bytes(content) != registered[relative]["sha256"]:
                raise ExecutionError(f"skill content hash mismatch: {relative}")
            injected.append(
                {
                    "path": relative,
                    "sha256": sha256_bytes(content),
                    "bytes_base64": base64.b64encode(content).decode("ascii"),
                }
            )
        return {"mode": mode, "injected": injected, "folder": None}
    if mode == "agent-folder":
        actual = complete_file_manifest(skill_root)
        if actual != manifest["files"]:
            raise ExecutionError("complete skill folder does not match manifest")
        return {
            "mode": mode,
            "injected": [],
            "folder": str(skill_root.resolve(strict=True)),
        }
    raise ExecutionError(f"unsupported execution mode: {mode}")


def prepare_one_shot_request(
    request_id: str,
    requested_model: str,
    capability_hash: str,
    canonical_scaffold: str,
    task: dict[str, Any],
    workspace_root: Path,
    injected_skill: list[dict[str, Any]] | None = None,
) -> OneShotRequest:
    """Build a prompt-only request from the explicitly declared solver-visible bytes."""

    task = validate_contract(task, "task")
    if task["allowed_tools"]:
        raise ExecutionError("one-shot calibration requires zero allowed tools")
    if not isinstance(canonical_scaffold, str) or not canonical_scaffold:
        raise ExecutionError("canonical scaffold must not be empty")

    materials: list[dict[str, str]] = []
    material_paths: set[str] = set()
    for entry in task["workspace_files"]:
        content = confined_path(workspace_root, entry["path"]).read_bytes()
        if sha256_bytes(content) != entry["sha256"]:
            raise ExecutionError(f"workspace file hash mismatch: {entry['path']}")
        materials.append(
            {
                "path": entry["path"],
                "bytes_base64": base64.b64encode(content).decode("ascii"),
            }
        )
        material_paths.add(entry["path"])

    for entry in injected_skill or []:
        if set(entry) != {"path", "sha256", "bytes_base64"}:
            raise ExecutionError("injected skill material fields are invalid")
        path = entry["path"]
        encoded = entry["bytes_base64"]
        if not isinstance(path, str) or not isinstance(encoded, str):
            raise ExecutionError("injected skill material is malformed")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ExecutionError("injected skill bytes are not valid base64") from exc
        if sha256_bytes(content) != entry["sha256"]:
            raise ExecutionError(f"injected skill hash mismatch: {path}")
        if path in material_paths:
            raise ExecutionError(f"duplicate prompt material path: {path}")
        materials.append({"path": path, "bytes_base64": encoded})
        material_paths.add(path)

    prompt_input = json.dumps(
        {
            "task": task["prompt"],
            "materials": materials,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    prompt = f"{canonical_scaffold}\n\n<aks-support-input>{prompt_input}</aks-support-input>"
    validate_request_fields(request_id, requested_model, capability_hash, prompt)
    return OneShotRequest(
        request_id=request_id,
        requested_model=requested_model,
        capability_hash=capability_hash,
        prompt=prompt,
    )


def observed_skill_access(
    mode: str, trajectory: dict[str, Any], registered_files: set[str]
) -> dict[str, Any]:
    events = trajectory.get("events", [])
    reads = [
        event.get("path")
        for event in events
        if event.get("type") in ("file-read", "script-invoked")
    ]
    reads = [path for path in reads if isinstance(path, str)]
    trace_available = bool(events) and all("type" in event for event in events)
    if mode == "agent-folder" and not trace_available:
        return {"trace_available": False, "observed": [], "missing": sorted(registered_files)}
    observed = sorted(set(reads) & registered_files)
    return {
        "trace_available": trace_available,
        "observed": observed,
        "missing": sorted(registered_files - set(observed)),
    }
