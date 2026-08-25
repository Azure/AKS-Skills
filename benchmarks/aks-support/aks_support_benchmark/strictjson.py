"""Strict JSON and JSONL parsing helpers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class StrictJSONError(ValueError):
    """Raised when structured input is ambiguous or malformed."""


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise StrictJSONError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def loads(text: str) -> Any:
    try:
        return json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=lambda value: (_ for _ in ()).throw(
                StrictJSONError(f"non-finite JSON number: {value}")
            ),
        )
    except json.JSONDecodeError as exc:
        raise StrictJSONError(str(exc)) from exc


def load(path: Path) -> Any:
    try:
        return loads(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError as exc:
        raise StrictJSONError(f"{path}: input is not UTF-8") from exc


def load_jsonl(path: Path) -> list[Any]:
    records: list[Any] = []
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not line.strip():
            raise StrictJSONError(f"{path}:{line_number}: blank JSONL record")
        try:
            records.append(loads(line))
        except StrictJSONError as exc:
            raise StrictJSONError(f"{path}:{line_number}: {exc}") from exc
    return records


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")


def dump(path: Path, value: Any) -> None:
    path.write_bytes(canonical_bytes(value) + b"\n")
