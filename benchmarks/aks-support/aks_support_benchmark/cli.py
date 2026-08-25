"""Command-line interface for the benchmark core."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .fixture import discover_cases, load_case, validate_skill_bundle
from .paths import confined_path, require_external
from .publication import scan_package
from .smoke import run_smoke
from .strictjson import load
from .contracts import validate_contract


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="aks-support-benchmark")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="validate public fixtures")
    validate.add_argument("fixtures", type=Path)

    smoke = subparsers.add_parser("smoke", help="run offline harness self-test")
    smoke.add_argument("fixtures", type=Path)

    self_test = subparsers.add_parser(
        "self-test", help="run the recorded offline harness self-test"
    )
    self_test.add_argument("--offline", action="store_true")
    self_test.add_argument("--no-model", action="store_true")

    contract = subparsers.add_parser("contract", help="validate one contract")
    contract.add_argument("path", type=Path)
    contract.add_argument("--kind")

    publication = subparsers.add_parser(
        "publication-scan", help="scan a declared release package"
    )
    publication.add_argument("root", type=Path)
    publication.add_argument("manifest", type=Path)

    private = subparsers.add_parser(
        "check-private-root", help="verify holdout root is external"
    )
    private.add_argument("path", type=Path)
    private.add_argument("--repo-root", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "validate":
            if args.fixtures.is_file():
                canary_set = validate_contract(load(args.fixtures), "canary-set")
                case_paths = [
                    confined_path(args.fixtures.parent, relative)
                    for relative in canary_set["cases"]
                ]
            else:
                case_paths = discover_cases(args.fixtures)
            if not case_paths:
                raise ValueError("no canary cases found")
            for case_path in case_paths:
                load_case(case_path)
            benchmark_root = Path(__file__).resolve().parents[1]
            for contract_path in sorted((benchmark_root / "contracts").glob("*.json")):
                validate_contract(load(contract_path))
            for trajectory_path in sorted(
                (benchmark_root / "fixtures" / "public-canaries").glob(
                    "*/recorded/trajectory.json"
                )
            ):
                validate_contract(load(trajectory_path), "trajectory")
            validate_skill_bundle(benchmark_root / "fixtures" / "skill-bundle")
            publication_manifest = load(
                benchmark_root / "publication-manifest.json"
            )
            if set(publication_manifest) != {"files"}:
                raise ValueError("publication manifest must contain only files")
            scan_package(benchmark_root, publication_manifest["files"])
            result = {"valid": True, "cases": len(case_paths)}
        elif args.command == "smoke":
            result = run_smoke(args.fixtures)
        elif args.command == "self-test":
            if not args.offline or not args.no_model:
                raise ValueError("self-test requires --offline and --no-model")
            fixtures = (
                Path(__file__).resolve().parents[1] / "fixtures" / "public-canaries"
            )
            result = run_smoke(fixtures)
        elif args.command == "contract":
            result = validate_contract(load(args.path), args.kind)
        elif args.command == "publication-scan":
            manifest = load(args.manifest)
            if set(manifest) != {"files"} or not isinstance(manifest["files"], list):
                raise ValueError("publication manifest must contain only files")
            scan_package(args.root, manifest["files"])
            result = {"valid": True, "files": len(manifest["files"])}
        elif args.command == "check-private-root":
            require_external(args.path, args.repo_root, "private holdout root")
            result = {"valid": True}
        else:
            raise AssertionError(args.command)
    except (OSError, ValueError) as exc:
        print(json.dumps({"valid": False, "error": str(exc)}), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0
