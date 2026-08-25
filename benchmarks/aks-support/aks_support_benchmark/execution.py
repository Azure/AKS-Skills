"""Execution-mode preparation and skill-observation checks."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

from .identity import complete_file_manifest, sha256_bytes
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
