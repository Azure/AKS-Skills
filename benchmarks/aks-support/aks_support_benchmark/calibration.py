"""Deterministic direct-context calibration identities and packets."""

from __future__ import annotations

import base64
import hashlib
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .contracts import (
    CONTRACT_VERSION,
    COPILOT_EXECUTION_ENVIRONMENT,
    COPILOT_EXECUTION_TRACK,
    COPILOT_MODEL_IDS,
    DIRECT_MODEL_CONTEXT,
    ContractError,
    validate_contract,
)
from .identity import sha256_bytes, sha256_value
from .paths import confined_path, require_external
from .strictjson import canonical_bytes, load, loads

SOURCE_COMMIT = "4e6a54942cdde657d95bef28adf8d8e9ebcaa5f5"
ACCEPTED_MANIFEST_SHA256 = (
    "14f77392e839976331f16d2dfc2fd05e4adcb33f8d465ca5f94d1870e5652c82"
)
ACCEPTED_ENTRIES_SHA256 = (
    "sha256:7c434944c9d571ae213ea0c830058e8c19bbfdd158536f382afcb249b9396c31"
)
REGISTERED_PACKAGES = (
    "aks-automatic-readiness",
    "aks-cluster-setup",
    "aks-cost-optimization",
    "aks-gpu-inference",
    "aks-known-issues",
    "aks-network-capture",
    "aks-troubleshooting",
)
PUBLIC_CANARY_CASE_IDS = (
    "public-canary-dns-nsg-udp53",
    "public-canary-quota-exceeded",
)
PACKET_SCHEMA_VERSION = "aks-support-direct-context-packet/v1"
FORBIDDEN_CASE_PACKET_TERMS = (
    b"verifier",
    b"gold",
    b"no-skill",
    b"skill arm",
    b"condition label",
    b"sibling",
    b"candidate identity",
)
DIRECT_CONTEXT_SCAFFOLD = (
    b"Diagnose the AKS support case using only the supplied case packet and any "
    b"attached skill files. Do not assume external state or another run's "
    b"response. Return strict JSON with exactly four string fields: "
    b"diagnosis.txt, evidence.txt, mutation.txt, and uncertainty.txt. Use them "
    b"for the root cause, decisive evidence, safe mutation or 'none', and "
    b"material uncertainty respectively."
)


class CalibrationError(ValueError):
    """Raised when immutable calibration construction fails closed."""


@dataclass(frozen=True)
class BundleFile:
    logical_path: str
    source_entry: dict[str, Any]
    content: bytes


@dataclass(frozen=True)
class CompleteSkillBundle:
    source_commit: str
    entries_digest: str
    files: tuple[BundleFile, ...]


@dataclass(frozen=True)
class SolverPacket:
    scaffold: bytes
    case_packet: bytes
    skill_files: tuple[BundleFile, ...]

    def canonical_bytes(self) -> bytes:
        return canonical_bytes(
            {
                "schema_version": PACKET_SCHEMA_VERSION,
                "scaffold_base64": base64.b64encode(self.scaffold).decode("ascii"),
                "case_packet_base64": base64.b64encode(self.case_packet).decode(
                    "ascii"
                ),
                "skill_files": [
                    {
                        "logical_path": item.logical_path,
                        "sha256": sha256_bytes(item.content),
                        "size": len(item.content),
                        "content_base64": base64.b64encode(item.content).decode(
                            "ascii"
                        ),
                    }
                    for item in self.skill_files
                ],
            }
        )


@dataclass(frozen=True)
class PacketPair:
    control: SolverPacket
    skill: SolverPacket


def _git(repo_root: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise CalibrationError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout


def _tree_records(raw: bytes) -> list[tuple[str, str, str, int | None, str]]:
    records: list[tuple[str, str, str, int | None, str]] = []
    for record in raw.split(b"\0"):
        if not record:
            continue
        try:
            metadata, raw_path = record.split(b"\t", 1)
            parts = metadata.decode("ascii").split()
            if len(parts) not in (3, 4):
                raise ValueError
            mode, object_type, object_id = parts[:3]
            size = None if len(parts) == 3 or parts[3] == "-" else int(parts[3])
            path = raw_path.decode("utf-8")
        except (UnicodeDecodeError, ValueError) as exc:
            raise CalibrationError("git tree contains an invalid record") from exc
        records.append((mode, object_type, object_id, size, path))
    return records


def _logical_skill_path(source_path: str, package: str) -> str:
    prefix = f"skills/{package}/"
    if not source_path.startswith(prefix):
        raise CalibrationError(f"skill entry escapes registered package: {source_path}")
    relative = source_path.removeprefix(prefix)
    return str(PurePosixPath(package) / relative)


def regenerate_complete_skill_bundle(repo_root: Path) -> CompleteSkillBundle:
    plugin = loads(_git(repo_root, "show", f"{SOURCE_COMMIT}:plugin.json").decode())
    if not isinstance(plugin, dict) or plugin.get("skills") != "./skills/":
        raise CalibrationError("source commit does not register ./skills/")

    package_records = _tree_records(
        _git(repo_root, "ls-tree", "-z", f"{SOURCE_COMMIT}:skills")
    )
    packages = tuple(record[4] for record in package_records)
    if packages != REGISTERED_PACKAGES:
        raise CalibrationError(f"registered package identity drift: {packages!r}")
    if any(record[0] != "040000" or record[1] != "tree" for record in package_records):
        raise CalibrationError("registered package root contains a non-tree entry")

    tree_records = _tree_records(
        _git(repo_root, "ls-tree", "-r", "-z", "-l", SOURCE_COMMIT, "--", "skills")
    )
    entries: list[dict[str, Any]] = []
    files: list[BundleFile] = []
    skill_markers: set[str] = set()
    for mode, object_type, object_id, tree_size, path in tree_records:
        if mode not in ("100644", "100755") or object_type != "blob":
            raise CalibrationError(
                f"unsupported Git object in registered skill bundle: "
                f"{mode} {object_type} {path}"
            )
        parts = PurePosixPath(path).parts
        if len(parts) < 3 or parts[0] != "skills" or parts[1] not in REGISTERED_PACKAGES:
            raise CalibrationError(f"unexpected registered skill path: {path}")
        package = parts[1]
        if parts[2:] == ("SKILL.md",):
            skill_markers.add(package)
        content = _git(repo_root, "cat-file", "blob", object_id)
        if tree_size is None or len(content) != tree_size:
            raise CalibrationError(f"Git blob size mismatch: {path}")
        entry = {
            "path": path,
            "package": package,
            "git_blob_id": object_id,
            "byte_sha256": sha256_bytes(content),
            "size_bytes": len(content),
            "git_mode": mode,
        }
        entries.append(entry)
        files.append(
            BundleFile(
                logical_path=_logical_skill_path(path, package),
                source_entry=entry,
                content=content,
            )
        )

    if skill_markers != set(REGISTERED_PACKAGES):
        missing = sorted(set(REGISTERED_PACKAGES) - skill_markers)
        raise CalibrationError(f"registered package missing SKILL.md: {missing}")
    if len(entries) != 46:
        raise CalibrationError(f"registered skill file count drift: {len(entries)}")
    digest = sha256_value(entries)
    if digest != ACCEPTED_ENTRIES_SHA256:
        raise CalibrationError(f"registered skill entries digest drift: {digest}")
    return CompleteSkillBundle(SOURCE_COMMIT, digest, tuple(files))


def load_complete_skill_bundle(
    repo_root: Path, accepted_manifest_path: Path
) -> CompleteSkillBundle:
    if not isinstance(accepted_manifest_path, Path):
        raise CalibrationError("accepted complete skill manifest path is required")
    manifest_path = require_external(
        accepted_manifest_path, repo_root, "accepted complete skill manifest"
    )
    try:
        manifest_bytes = manifest_path.read_bytes()
    except OSError as exc:
        raise CalibrationError(
            "accepted complete skill manifest is unavailable"
        ) from exc
    actual_manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
    if actual_manifest_hash != ACCEPTED_MANIFEST_SHA256:
        raise CalibrationError(
            f"accepted complete skill manifest hash mismatch: {actual_manifest_hash}"
        )
    try:
        manifest = loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise CalibrationError("accepted complete skill manifest is invalid") from exc
    if not isinstance(manifest, dict):
        raise CalibrationError("accepted complete skill manifest must be an object")
    if manifest.get("source_commit") != SOURCE_COMMIT:
        raise CalibrationError("accepted complete skill manifest commit drift")
    if manifest.get("bundle_entries_sha256") != ACCEPTED_ENTRIES_SHA256:
        raise CalibrationError("accepted complete skill manifest digest drift")
    registration = manifest.get("registration_resolution")
    if not isinstance(registration, dict):
        raise CalibrationError("accepted manifest registration is missing")
    expected_registration = {
        "plugin_manifest": "plugin.json",
        "registered_skills_root": "skills/",
        "registered_packages": list(REGISTERED_PACKAGES),
        "package_count": len(REGISTERED_PACKAGES),
        "file_count": 46,
    }
    for key, expected in expected_registration.items():
        if registration.get(key) != expected:
            raise CalibrationError(f"accepted manifest registration drift: {key}")

    bundle = regenerate_complete_skill_bundle(repo_root)
    expected_entries = [item.source_entry for item in bundle.files]
    if manifest.get("entries") != expected_entries:
        raise CalibrationError("accepted manifest entries do not match Git objects")
    if sha256_value(manifest["entries"]) != ACCEPTED_ENTRIES_SHA256:
        raise CalibrationError("accepted manifest canonical entries digest mismatch")
    return bundle


def _stable_identifier(prefix: str, identity: dict[str, Any]) -> str:
    digest = hashlib.sha256(prefix.encode("ascii") + canonical_bytes(identity)).hexdigest()
    return f"{prefix}-{digest[:24]}"


def build_calibration_matrix(
    model_ids: tuple[str, ...] = COPILOT_MODEL_IDS,
) -> tuple[dict[str, Any], ...]:
    if model_ids != COPILOT_MODEL_IDS:
        if "auto" in model_ids:
            raise ContractError("auto is not an explicit Copilot model ID")
        if len(set(model_ids)) != len(model_ids):
            raise ContractError("Copilot model IDs contain duplicates")
        unknown = sorted(set(model_ids) - set(COPILOT_MODEL_IDS))
        if unknown:
            raise ContractError(f"unknown Copilot model IDs: {unknown}")
        raise ContractError("Copilot model identity drift")

    cells: list[dict[str, Any]] = []
    for model_id in model_ids:
        for case_id in PUBLIC_CANARY_CASE_IDS:
            for skill_available in (False, True):
                identity = {
                    "mode": DIRECT_MODEL_CONTEXT,
                    "execution_track": COPILOT_EXECUTION_TRACK,
                    "execution_environment": COPILOT_EXECUTION_ENVIRONMENT,
                    "model_id": model_id,
                    "case_id": case_id,
                    "skill_available": skill_available,
                }
                cell = {
                    "contract_version": CONTRACT_VERSION,
                    "kind": "calibration-cell",
                    "cell_id": _stable_identifier("cell", identity),
                    **identity,
                    "fresh_context_id": _stable_identifier("context", identity),
                    "attempt_id": _stable_identifier("attempt", identity),
                }
                cells.append(validate_contract(cell, "calibration-cell"))
    validate_calibration_matrix(cells)
    return tuple(cells)


def validate_calibration_matrix(cells: list[dict[str, Any]]) -> None:
    if len(cells) != 92:
        raise ContractError(f"calibration matrix must contain 92 cells, got {len(cells)}")
    expected = _matrix_without_validation()
    if cells != expected:
        raise ContractError("calibration matrix identity drift")
    for field in ("cell_id", "fresh_context_id", "attempt_id"):
        values = [cell[field] for cell in cells]
        if len(values) != len(set(values)):
            raise ContractError(f"calibration matrix has duplicate {field}")


def _matrix_without_validation() -> list[dict[str, Any]]:
    cells: list[dict[str, Any]] = []
    for model_id in COPILOT_MODEL_IDS:
        for case_id in PUBLIC_CANARY_CASE_IDS:
            for skill_available in (False, True):
                identity = {
                    "mode": DIRECT_MODEL_CONTEXT,
                    "execution_track": COPILOT_EXECUTION_TRACK,
                    "execution_environment": COPILOT_EXECUTION_ENVIRONMENT,
                    "model_id": model_id,
                    "case_id": case_id,
                    "skill_available": skill_available,
                }
                cells.append(
                    {
                        "contract_version": CONTRACT_VERSION,
                        "kind": "calibration-cell",
                        "cell_id": _stable_identifier("cell", identity),
                        **identity,
                        "fresh_context_id": _stable_identifier("context", identity),
                        "attempt_id": _stable_identifier("attempt", identity),
                    }
                )
    return cells


def build_case_packet(case_root: Path) -> bytes:
    case = validate_contract(load(case_root / "case.json"), "case")
    if PurePosixPath(case["task_path"]).parts[0] != "solver":
        raise CalibrationError("case task must be confined to the solver packet")
    task_path = confined_path(case_root, case["task_path"])
    task = validate_contract(load(task_path), "task")
    if case["case_id"] != task["case_id"]:
        raise CalibrationError("case and task identity mismatch")

    workspace_files: list[dict[str, Any]] = []
    for entry in task["workspace_files"]:
        content = confined_path(task_path.parent, entry["path"]).read_bytes()
        if sha256_bytes(content) != entry["sha256"]:
            raise CalibrationError(f"case workspace file hash mismatch: {entry['path']}")
        _assert_case_packet_isolation(entry["path"].encode(), content)
        workspace_files.append(
            {
                "name": entry["path"],
                "sha256": entry["sha256"],
                "size": len(content),
                "content_base64": base64.b64encode(content).decode("ascii"),
            }
        )
    packet = canonical_bytes(
        {
            "schema_version": PACKET_SCHEMA_VERSION,
            "case_id": case["case_id"],
            "task_id": task["task_id"],
            "prompt": task["prompt"],
            "workspace_files": workspace_files,
            "allowed_tools": task["allowed_tools"],
            "prohibited_actions": task["prohibited_actions"],
        }
    )
    _assert_case_packet_isolation(task["prompt"].encode(), packet)
    case_root_bytes = str(case_root.resolve()).encode()
    if case_root_bytes in packet:
        raise CalibrationError("case packet exposes its repository location")
    return packet


def _assert_case_packet_isolation(*values: bytes) -> None:
    for value in values:
        lowered = value.lower()
        for forbidden in FORBIDDEN_CASE_PACKET_TERMS:
            if forbidden in lowered:
                raise CalibrationError(
                    f"case packet exposes prohibited material: "
                    f"{forbidden.decode('ascii')}"
                )


def build_solver_packet_pair(
    case_root: Path, bundle: CompleteSkillBundle
) -> PacketPair:
    case_packet = build_case_packet(case_root)
    return PacketPair(
        control=SolverPacket(DIRECT_CONTEXT_SCAFFOLD, case_packet, ()),
        skill=SolverPacket(DIRECT_CONTEXT_SCAFFOLD, case_packet, bundle.files),
    )
