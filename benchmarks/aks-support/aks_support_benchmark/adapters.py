"""Dependency-free adapter implementations and future-host contracts."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .contracts import validate_contract
from .paths import safe_environment
from .strictjson import StrictJSONError, load, loads


class AdapterError(RuntimeError):
    """Raised for adapter protocol or execution failures."""


class Adapter(Protocol):
    def invoke(self, request: dict[str, Any]) -> dict[str, Any]:
        """Invoke a host through structured request/response objects."""


@dataclass(frozen=True)
class CommandAdapter:
    argv: list[str]
    allowed_env: list[str]
    env: dict[str, str]

    def __post_init__(self) -> None:
        if not self.argv or not all(isinstance(item, str) and item for item in self.argv):
            raise AdapterError("argv must contain non-empty strings")
        if any("\x00" in item for item in self.argv):
            raise AdapterError("argv contains NUL")
        safe_environment(self.env, self.allowed_env, {})

    def invoke(self, request: dict[str, Any]) -> dict[str, Any]:
        completed = subprocess.run(
            self.argv,
            input=json.dumps(request, separators=(",", ":")),
            text=True,
            capture_output=True,
            shell=False,
            check=False,
            env=safe_environment(self.env, self.allowed_env, {}),
        )
        if completed.returncode != 0:
            raise AdapterError(
                f"adapter exited {completed.returncode}: {completed.stderr.strip()}"
            )
        try:
            response = loads(completed.stdout)
        except StrictJSONError as exc:
            raise AdapterError("adapter stdout is not one JSON object") from exc
        if not isinstance(response, dict):
            raise AdapterError("adapter response must be an object")
        return response


@dataclass(frozen=True)
class RecordedAdapter:
    trajectory_path: Path

    def invoke(self, request: dict[str, Any]) -> dict[str, Any]:
        del request
        return validate_contract(load(self.trajectory_path), "trajectory")


@dataclass(frozen=True)
class ManualAdapter:
    record: dict[str, Any]

    def invoke(self, request: dict[str, Any]) -> dict[str, Any]:
        del request
        if set(self.record) != {"recorded_by", "recorded_at", "trajectory"}:
            raise AdapterError("manual record fields are incomplete or unknown")
        if not all(
            isinstance(self.record[name], str) and self.record[name]
            for name in ("recorded_by", "recorded_at")
        ):
            raise AdapterError("manual record provenance must be non-empty")
        return validate_contract(self.record["trajectory"], "trajectory")


def validate_future_host_config(config: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "azure-openai": {"provider", "deployment_env", "endpoint_env"},
        "foundry": {"provider", "model_env", "project_env"},
        "openai-compatible": {"provider", "model_env", "base_url_env"},
        "agent-host": {"provider", "host_id", "config_env"},
    }
    provider = config.get("provider")
    expected = allowed.get(provider)
    if expected is None or set(config) != expected:
        raise AdapterError(
            f"future host config fields mismatch for provider {provider!r}"
        )
    for name, value in config.items():
        if name == "provider":
            continue
        if not isinstance(value, str) or not value:
            raise AdapterError(f"{name} must name a configured environment variable")
        if "://" in value or "/" in value or "\\" in value:
            raise AdapterError(f"{name} must not contain an endpoint or path")
    return config
