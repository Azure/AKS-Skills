"""Public-canary fixture loading and isolation validation."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .contracts import validate_contract
from .identity import bundle_hash, complete_file_manifest, sha256_bytes
from .paths import confined_path, require_disjoint
from .strictjson import load


def load_case(case_root: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    case = validate_contract(load(confined_path(case_root, "case.json")), "case")
    task_path = confined_path(case_root, case["task_path"])
    verifier_path = confined_path(case_root, case["verifier_path"])
    task = validate_contract(load(task_path), "task")
    verifier = validate_contract(load(verifier_path), "verifier")
    if task["case_id"] != case["case_id"]:
        raise ValueError("task case_id does not match case")
    require_disjoint(
        ("solver workspace", task_path.parent),
        ("verifier path", verifier_path.parent),
    )
    if "answer_path" in case:
        answer_path = confined_path(case_root, case["answer_path"])
        if not answer_path.is_relative_to(verifier_path.parent):
            raise ValueError("answer material must be under the verifier path")
    for entry in task["workspace_files"]:
        workspace_file = confined_path(task_path.parent, entry["path"])
        if sha256_bytes(workspace_file.read_bytes()) != entry["sha256"]:
            raise ValueError(f"workspace file hash mismatch: {entry['path']}")
    verifier_without_hash = dict(verifier)
    declared_hash = verifier_without_hash.pop("verifier_hash")
    from .identity import sha256_value

    if sha256_value(verifier_without_hash) != declared_hash:
        raise ValueError("verifier contract hash mismatch")
    for gold_file in verifier["gold_files"]:
        confined_path(verifier_path.parent, gold_file)
    return case, task, verifier


def discover_cases(root: Path) -> list[Path]:
    return sorted(path.parent for path in root.glob("*/case.json"))


def validate_skill_bundle(bundle_root: Path) -> dict[str, Any]:
    manifest = validate_contract(load(bundle_root / "manifest.json"), "skill-bundle")
    skill_root = confined_path(bundle_root, manifest["root"])
    actual = complete_file_manifest(skill_root)
    if actual != manifest["files"]:
        raise ValueError("skill bundle file manifest mismatch")
    if bundle_hash(actual) != manifest["bundle_hash"]:
        raise ValueError("skill bundle hash mismatch")
    return manifest
