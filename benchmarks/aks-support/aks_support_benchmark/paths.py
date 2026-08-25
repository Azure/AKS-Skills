"""Path confinement and workspace-isolation checks."""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath


class PathSafetyError(ValueError):
    """Raised when a path can escape its declared root."""


def normalized_relative(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise PathSafetyError("path must be a non-empty string without NUL")
    if "\\" in value:
        raise PathSafetyError(f"path must use POSIX separators: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or value != path.as_posix():
        raise PathSafetyError(f"path is not normalized relative POSIX: {value!r}")
    if any(part in ("", ".", "..") for part in path.parts):
        raise PathSafetyError(f"path contains an escape segment: {value!r}")
    return path


def confined_path(root: Path, relative: str, *, must_exist: bool = True) -> Path:
    normalized = normalized_relative(relative)
    root_resolved = root.resolve(strict=True)
    candidate = root.joinpath(*normalized.parts)
    try:
        resolved = candidate.resolve(strict=must_exist)
    except (FileNotFoundError, RuntimeError) as exc:
        raise PathSafetyError(f"unresolvable path: {relative}") from exc
    if not resolved.is_relative_to(root_resolved):
        raise PathSafetyError(f"path or symlink escapes root: {relative}")
    return resolved


def require_external(path: Path, repo_root: Path, label: str) -> Path:
    resolved = path.resolve(strict=False)
    repository = repo_root.resolve(strict=True)
    if resolved == repository or resolved.is_relative_to(repository):
        raise PathSafetyError(f"{label} must resolve outside repository root")
    return resolved


def require_disjoint(*named_paths: tuple[str, Path]) -> None:
    resolved = [(name, path.resolve(strict=False)) for name, path in named_paths]
    for index, (left_name, left_path) in enumerate(resolved):
        for right_name, right_path in resolved[index + 1 :]:
            if (
                left_path == right_path
                or left_path.is_relative_to(right_path)
                or right_path.is_relative_to(left_path)
            ):
                raise PathSafetyError(
                    f"{left_name} and {right_name} must be isolated"
                )


def is_symlink_component(root: Path, relative: str) -> bool:
    current = root
    for part in normalized_relative(relative).parts:
        current = current / part
        if current.is_symlink():
            return True
    return False


def safe_environment(
    requested: dict[str, str], allowed_names: list[str], inherited: dict[str, str] | None = None
) -> dict[str, str]:
    allowed = set(allowed_names)
    if len(allowed) != len(allowed_names):
        raise PathSafetyError("environment allowlist contains duplicates")
    unknown = set(requested) - allowed
    if unknown:
        raise PathSafetyError(
            f"environment variables are not allowlisted: {sorted(unknown)}"
        )
    source = os.environ if inherited is None else inherited
    return {name: requested.get(name, source[name]) for name in allowed if name in requested or name in source}
