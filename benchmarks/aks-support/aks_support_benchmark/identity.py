"""Content-addressed release and run identity helpers."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .paths import confined_path
from .strictjson import canonical_bytes


def sha256_bytes(content: bytes) -> str:
    return f"sha256:{hashlib.sha256(content).hexdigest()}"


def sha256_value(value: Any) -> str:
    return sha256_bytes(canonical_bytes(value))


def file_manifest(root: Path, relative_paths: list[str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for relative in sorted(relative_paths):
        path = confined_path(root, relative)
        if not path.is_file():
            raise ValueError(f"manifest entry is not a file: {relative}")
        content = path.read_bytes()
        entries.append(
            {"path": relative, "sha256": sha256_bytes(content), "size": len(content)}
        )
    return entries


def complete_file_manifest(root: Path) -> list[dict[str, Any]]:
    root_resolved = root.resolve(strict=True)
    paths: list[str] = []
    for candidate in sorted(root_resolved.rglob("*")):
        if candidate.is_symlink():
            raise ValueError(f"skill bundle must not contain symlinks: {candidate}")
        if candidate.is_file():
            paths.append(candidate.relative_to(root_resolved).as_posix())
    return file_manifest(root_resolved, paths)


def bundle_hash(entries: list[dict[str, Any]]) -> str:
    return sha256_value(entries)


def immutable_run_id(identities: dict[str, str], pair_id: str, repetition: int) -> str:
    digest = sha256_value(
        {"identities": identities, "pair_id": pair_id, "repetition": repetition}
    ).split(":", 1)[1]
    return f"run-{digest[:24]}"


def immutable_release_id(identities: dict[str, str]) -> str:
    digest = sha256_value(identities).split(":", 1)[1]
    return f"release-{digest[:24]}"
