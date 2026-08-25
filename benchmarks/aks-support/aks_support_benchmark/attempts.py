"""Immutable, content-addressed evidence for benchmark attempts."""

from __future__ import annotations

import os
import re
import shutil
from enum import Enum
from pathlib import Path
from typing import Any, Iterable

from .contracts import ID_RE
from .identity import complete_file_manifest, sha256_bytes
from .paths import confined_path
from .strictjson import canonical_bytes, load


ATTEMPT_FORMAT_VERSION = "aks-support-attempt/v1"
_GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class AttemptSealError(ValueError):
    """Raised when attempt evidence cannot be sealed or verified."""


class FailureClass(str, Enum):
    """Mutually exclusive failure classes used by retry policy."""

    NONE = "none"
    PERMANENT_MODEL_CAPABILITY_REJECTION = "permanent-model-capability-rejection"
    TRANSIENT_PLATFORM_FAILURE = "transient-platform-failure"
    TRANSIENT_INFRASTRUCTURE_FAILURE = "transient-infrastructure-failure"

    @property
    def retryable(self) -> bool:
        return self in {
            self.TRANSIENT_PLATFORM_FAILURE,
            self.TRANSIENT_INFRASTRUCTURE_FAILURE,
        }


IDENTITY_FIELDS = {
    "accepted_sha",
    "mode",
    "execution_track",
    "environment",
    "model",
    "fresh_context",
    "pair_id",
    "condition",
    "packet_hash",
    "scaffold_hash",
    "skill_hash",
}


def classify_failure(
    *,
    model_capability_rejection: bool = False,
    platform_failure: bool = False,
    infrastructure_failure: bool = False,
) -> FailureClass:
    """Classify one observed terminal condition without precedence guessing."""

    signals = {
        FailureClass.PERMANENT_MODEL_CAPABILITY_REJECTION: model_capability_rejection,
        FailureClass.TRANSIENT_PLATFORM_FAILURE: platform_failure,
        FailureClass.TRANSIENT_INFRASTRUCTURE_FAILURE: infrastructure_failure,
    }
    if any(type(value) is not bool for value in signals.values()):
        raise AttemptSealError("failure classification signals must be boolean")
    active = [kind for kind, present in signals.items() if present]
    if len(active) > 1:
        raise AttemptSealError("failure classification is ambiguous")
    return active[0] if active else FailureClass.NONE


def validate_attempt_identity(identity: dict[str, Any]) -> dict[str, Any]:
    """Validate the local envelope used until attempt fields enter v1 contracts."""

    if not isinstance(identity, dict) or set(identity) != IDENTITY_FIELDS:
        missing = IDENTITY_FIELDS - set(identity) if isinstance(identity, dict) else IDENTITY_FIELDS
        unknown = set(identity) - IDENTITY_FIELDS if isinstance(identity, dict) else set()
        raise AttemptSealError(
            f"attempt identity fields mismatch; missing={sorted(missing)}, "
            f"unknown={sorted(unknown)}"
        )
    if not isinstance(identity["accepted_sha"], str) or not _GIT_SHA_RE.fullmatch(
        identity["accepted_sha"]
    ):
        raise AttemptSealError("accepted_sha must be a full lowercase Git SHA")
    for name in ("mode", "execution_track", "environment", "model"):
        if not isinstance(identity[name], str) or not identity[name].strip():
            raise AttemptSealError(f"{name} must be a non-empty string")
    if identity["mode"] not in ("direct-model-context", "agent-folder"):
        raise AttemptSealError(f"unsupported execution mode: {identity['mode']!r}")
    if type(identity["fresh_context"]) is not bool:
        raise AttemptSealError("fresh_context must be boolean")
    if not isinstance(identity["pair_id"], str) or not ID_RE.fullmatch(
        identity["pair_id"]
    ):
        raise AttemptSealError("pair_id must be a valid identifier")
    if identity["condition"] not in ("skill", "no-skill"):
        raise AttemptSealError("condition must be 'skill' or 'no-skill'")
    for name in ("packet_hash", "scaffold_hash"):
        if not isinstance(identity[name], str) or not _HASH_RE.fullmatch(identity[name]):
            raise AttemptSealError(f"{name} must be a sha256 content hash")
    skill_hash = identity["skill_hash"]
    if identity["condition"] == "skill":
        if not isinstance(skill_hash, str) or not _HASH_RE.fullmatch(skill_hash):
            raise AttemptSealError("skill condition requires a sha256 skill_hash")
    elif skill_hash is not None:
        raise AttemptSealError("no-skill condition requires skill_hash=null")
    return identity


def seal_attempt(
    source_root: Path,
    seals_root: Path,
    attempt_id: str,
    preregistered_attempt_ids: Iterable[str],
    identity: dict[str, Any],
    failure: FailureClass = FailureClass.NONE,
    *,
    required_artifacts: Iterable[str] = (),
) -> dict[str, Any]:
    """Copy an attempt once, then seal its complete byte manifest."""

    _validate_attempt_id(attempt_id)
    registered = list(preregistered_attempt_ids)
    if len(registered) != len(set(registered)):
        raise AttemptSealError("preregistered attempt IDs contain duplicates")
    if attempt_id not in registered:
        raise AttemptSealError(f"attempt_id was not preregistered: {attempt_id}")
    for registered_id in registered:
        _validate_attempt_id(registered_id)
    validated_identity = validate_attempt_identity(identity)
    if not isinstance(failure, FailureClass):
        raise AttemptSealError("failure must be a FailureClass")

    source = source_root.resolve(strict=True)
    if not source.is_dir():
        raise AttemptSealError("attempt source must be a directory")
    seals_resolved = seals_root.resolve(strict=False)
    if seals_resolved == source or seals_resolved.is_relative_to(source):
        raise AttemptSealError("seal root must be outside the attempt source")
    source_manifest = complete_file_manifest(source)
    if not source_manifest:
        raise AttemptSealError("attempt source contains no evidence")
    available = {entry["path"] for entry in source_manifest}
    required = list(required_artifacts)
    if len(required) != len(set(required)):
        raise AttemptSealError("required artifacts contain duplicates")
    missing = set(required) - available
    if missing:
        raise AttemptSealError(f"required attempt artifacts missing: {sorted(missing)}")

    seals_root.mkdir(parents=True, exist_ok=True)
    destination = seals_root / attempt_id
    try:
        destination.mkdir()
    except FileExistsError as exc:
        raise AttemptSealError(f"attempt is already sealed: {attempt_id}") from exc

    artifacts_root = destination / "artifacts"
    artifacts_root.mkdir()
    try:
        for entry in source_manifest:
            source_path = confined_path(source, entry["path"])
            destination_path = confined_path(
                artifacts_root, entry["path"], must_exist=False
            )
            destination_path.parent.mkdir(parents=True, exist_ok=True)
            with source_path.open("rb") as reader, destination_path.open("xb") as writer:
                shutil.copyfileobj(reader, writer)
                writer.flush()
                os.fsync(writer.fileno())

        copied_manifest = complete_file_manifest(artifacts_root)
        if copied_manifest != source_manifest:
            raise AttemptSealError("copied artifact manifest does not match source")
        manifest = {
            "format_version": ATTEMPT_FORMAT_VERSION,
            "attempt_id": attempt_id,
            "identity": validated_identity,
            "failure": {
                "kind": failure.value,
                "retryable": failure.retryable,
            },
            "artifacts": copied_manifest,
        }
        manifest_bytes = canonical_bytes(manifest) + b"\n"
        _write_exclusive(destination / "manifest.json", manifest_bytes)
        _write_exclusive(
            destination / "manifest.sha256",
            (sha256_bytes(manifest_bytes) + "\n").encode("ascii"),
        )
        _fsync_directory(destination)
        _fsync_directory(seals_root)
    except Exception:
        # The claimed ID remains reserved. A partial directory is intentionally
        # not removed because retrying under the same ID would erase evidence.
        raise
    return load_sealed_attempt(destination)


def load_sealed_attempt(attempt_root: Path) -> dict[str, Any]:
    """Verify a sealed attempt and return its manifest."""

    root = attempt_root.resolve(strict=True)
    if not root.is_dir():
        raise AttemptSealError("sealed attempt must be a directory")
    top_level = {path.name for path in root.iterdir()}
    expected_top_level = {"artifacts", "manifest.json", "manifest.sha256"}
    if top_level != expected_top_level:
        raise AttemptSealError(
            "sealed attempt files mismatch; "
            f"missing={sorted(expected_top_level - top_level)}, "
            f"unknown={sorted(top_level - expected_top_level)}"
        )
    if any((root / name).is_symlink() for name in expected_top_level):
        raise AttemptSealError("sealed attempt top-level entries must not be symlinks")
    manifest_path = root / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    expected_digest = sha256_bytes(manifest_bytes)
    try:
        declared_digest = (root / "manifest.sha256").read_text(encoding="ascii").strip()
    except UnicodeDecodeError as exc:
        raise AttemptSealError("manifest digest is not ASCII") from exc
    if declared_digest != expected_digest:
        raise AttemptSealError("sealed manifest hash mismatch")
    manifest = load(manifest_path)
    _validate_seal_manifest(manifest)
    if manifest_bytes != canonical_bytes(manifest) + b"\n":
        raise AttemptSealError("sealed manifest is not canonical JSON")
    if root.name != manifest["attempt_id"]:
        raise AttemptSealError("attempt directory does not match attempt_id")
    actual_artifacts = complete_file_manifest(root / "artifacts")
    if actual_artifacts != manifest["artifacts"]:
        raise AttemptSealError("sealed artifact manifest mismatch")
    return manifest


def read_sealed_artifact(attempt_root: Path, relative_path: str) -> bytes:
    """Read a verified artifact declared by a sealed attempt."""

    manifest = load_sealed_attempt(attempt_root)
    declared = {entry["path"] for entry in manifest["artifacts"]}
    if relative_path not in declared:
        raise AttemptSealError(f"artifact is not in sealed manifest: {relative_path}")
    return confined_path(attempt_root / "artifacts", relative_path).read_bytes()


def _validate_attempt_id(value: str) -> None:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise AttemptSealError(f"invalid attempt_id: {value!r}")


def _validate_seal_manifest(value: Any) -> None:
    expected = {"format_version", "attempt_id", "identity", "failure", "artifacts"}
    if not isinstance(value, dict) or set(value) != expected:
        raise AttemptSealError("sealed manifest has missing or unknown fields")
    if value["format_version"] != ATTEMPT_FORMAT_VERSION:
        raise AttemptSealError("unsupported attempt format")
    _validate_attempt_id(value["attempt_id"])
    validate_attempt_identity(value["identity"])
    failure = value["failure"]
    if not isinstance(failure, dict) or set(failure) != {"kind", "retryable"}:
        raise AttemptSealError("failure classification fields are invalid")
    try:
        failure_class = FailureClass(failure["kind"])
    except (TypeError, ValueError) as exc:
        raise AttemptSealError("unknown failure classification") from exc
    if type(failure["retryable"]) is not bool or failure["retryable"] != failure_class.retryable:
        raise AttemptSealError("failure retryability does not match its class")
    artifacts = value["artifacts"]
    if not isinstance(artifacts, list) or not artifacts:
        raise AttemptSealError("sealed attempt must declare artifacts")
    paths: set[str] = set()
    for entry in artifacts:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "size"}:
            raise AttemptSealError("artifact manifest entry fields are invalid")
        if entry["path"] in paths:
            raise AttemptSealError(f"duplicate sealed artifact path: {entry['path']}")
        if not isinstance(entry["sha256"], str) or not _HASH_RE.fullmatch(entry["sha256"]):
            raise AttemptSealError("artifact sha256 is invalid")
        if type(entry["size"]) is not int or entry["size"] < 0:
            raise AttemptSealError("artifact size is invalid")
        paths.add(entry["path"])


def _write_exclusive(path: Path, content: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
    try:
        remaining = memoryview(content)
        while remaining:
            written = os.write(descriptor, remaining)
            if written == 0:
                raise OSError(f"failed to write sealed file: {path}")
            remaining = remaining[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
