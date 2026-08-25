"""Fail-closed publication and sensitive-data validation."""

from __future__ import annotations

import re
from pathlib import Path

from .paths import confined_path


class PublicationError(ValueError):
    """Raised when a release contains unsafe or unscannable material."""


TEXT_EXTENSIONS = {
    ".json",
    ".jsonl",
    ".md",
    ".txt",
    ".py",
    ".yaml",
    ".yml",
}

PROHIBITED_PATTERNS = (
    ("internal organization", re.compile(r"\bms" + r"azure\b", re.IGNORECASE)),
    ("internal host", re.compile(r"\b[a-z0-9.-]+\.corp\.microsoft\.com\b", re.IGNORECASE)),
    ("private endpoint", re.compile(r"https?://(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+)", re.IGNORECASE)),
    ("Azure resource ID", re.compile(r"/subscriptions/[0-9a-f-]+/", re.IGNORECASE)),
    ("globally unique identifier", re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b", re.IGNORECASE)),
    ("secret assignment", re.compile(r"(?:api[_-]?key|client[_-]?secret|password)\s*[:=]\s*[^\s\"']+", re.IGNORECASE)),
    (
        "private root",
        re.compile(
            "(?:/" + "Users/|/" + r"home/|[A-Za-z]:\\\\Users\\\\)"
        ),
    ),
    (
        "absolute path",
        re.compile(
            r"(?:^|[\s\"'`=])/(?!/)[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)+",
            re.MULTILINE,
        ),
    ),
)


def scan_file(path: Path) -> list[str]:
    if path.suffix.lower() not in TEXT_EXTENSIONS:
        raise PublicationError(f"unknown packaged extension: {path.suffix or '<none>'}")
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise PublicationError(f"packaged text is not UTF-8: {path}") from exc
    findings: list[str] = []
    for label, pattern in PROHIBITED_PATTERNS:
        if pattern.search(text):
            findings.append(label)
    return findings


def scan_package(root: Path, relative_paths: list[str]) -> None:
    if not relative_paths:
        raise PublicationError("publication package must declare files")
    for relative in relative_paths:
        try:
            candidate = confined_path(root, relative)
        except ValueError as exc:
            raise PublicationError(str(exc)) from exc
        if not candidate.is_file():
            raise PublicationError(f"packaged path is not a file: {relative}")
        findings = scan_file(candidate)
        if findings:
            raise PublicationError(f"{relative}: prohibited content: {findings}")
