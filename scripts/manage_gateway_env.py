#!/usr/bin/env python3
"""
manage_gateway_env.py — the ONE durable, general-purpose way this fleet edits a
single environment variable on an Azure Container App.

WHY THIS EXISTS
---------------
Editing Container App env vars with inline
    az containerapp update --set-env-vars "KEY=value"
has repeatedly broken in production because the value travels through several
layers of shell + Azure-CLI string parsing:

  * JSON-array values (OAUTH_CLIENTS) got emptied by a jq-on-empty edge case.
  * --set-env-vars silently REPLACED a secretRef binding with a literal value.
  * A value containing '@' (matthew@innd.com) was misread as an @file reference.

This script sidesteps ALL of that. It never builds a "KEY=value" CLI string.
Instead it:

  1. reads the FULL resource as JSON              (az containerapp show -o json)
  2. edits properties.template.containers[N].env  (as a Python list of dicts)
  3. writes a YAML manifest and applies it        (az containerapp update --yaml)

Because the value only ever lives inside a Python string that we serialise to
JSON/YAML, special characters ('@', quotes, JSON arrays, spaces) are just data.

SAFETY GUARANTEES
-----------------
  * secretRef preservation: updating a key that is currently a secretRef will
    REFUSE unless you pass --type secretref (or explicitly opt into converting
    it with --allow-type-change). We never silently turn a secretRef into a
    literal or vice-versa.
  * regression guard: after computing the new env list we diff it against the
    old one and FAIL LOUDLY if ANY key other than the target changed in any way
    (value, secretRef, or presence).

This module is import-safe and unit-tested: all the pure logic lives in
functions that take/return plain data structures, so it runs with no Azure
access. The `main()` entrypoint is the only part that shells out to `az`.
"""

from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import tempfile
from typing import Any

# --------------------------------------------------------------------------- #
# Pure logic (no Azure, fully unit-testable)
# --------------------------------------------------------------------------- #


def normalize_env(env: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Return a stable, comparable copy of an env array.

    Azure returns each entry as {"name","value"} or {"name","secretRef"}.
    We keep only the keys that matter and drop Nones so comparisons are exact.
    """
    out: list[dict[str, Any]] = []
    for item in env or []:
        entry: dict[str, Any] = {"name": item["name"]}
        if item.get("secretRef") is not None:
            entry["secretRef"] = item["secretRef"]
        if item.get("value") is not None:
            entry["value"] = item["value"]
        out.append(entry)
    return out


def find_entry(env: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    for item in env:
        if item.get("name") == name:
            return item
    return None


def entry_kind(entry: dict[str, Any] | None) -> str:
    """'literal', 'secretref', or 'absent'."""
    if entry is None:
        return "absent"
    if "secretRef" in entry:
        return "secretref"
    return "literal"


def apply_change(
    env: list[dict[str, Any]],
    *,
    name: str,
    value: str,
    value_type: str,          # "literal" | "secretref"
    operation: str,           # "add" | "update" | "upsert"
    allow_type_change: bool,
) -> list[dict[str, Any]]:
    """Return a NEW env list with exactly the target key changed.

    Raises ValueError on any policy violation (never mutates the input).
    """
    if value_type not in ("literal", "secretref"):
        raise ValueError(f"value_type must be literal|secretref, got {value_type!r}")
    if operation not in ("add", "update", "upsert"):
        raise ValueError(f"operation must be add|update|upsert, got {operation!r}")

    env = normalize_env(env)
    existing = find_entry(env, name)
    existing_kind = entry_kind(existing)

    if operation == "add" and existing is not None:
        raise ValueError(
            f"operation=add but env var {name!r} already exists "
            f"(kind={existing_kind}). Use operation=update or upsert."
        )
    if operation == "update" and existing is None:
        raise ValueError(
            f"operation=update but env var {name!r} does not exist. "
            f"Use operation=add or upsert."
        )

    # secretRef-preservation policy: refuse to flip type unless told to.
    if existing is not None and existing_kind != value_type and not allow_type_change:
        raise ValueError(
            f"env var {name!r} is currently a {existing_kind}, but you asked to "
            f"write it as a {value_type}. Refusing to silently change its type. "
            f"Pass --allow-type-change to intentionally convert "
            f"{existing_kind} -> {value_type}."
        )

    new_entry: dict[str, Any] = {"name": name}
    if value_type == "secretref":
        new_entry["secretRef"] = value
    else:
        new_entry["value"] = value

    new_env: list[dict[str, Any]] = []
    replaced = False
    for item in env:
        if item.get("name") == name:
            new_env.append(new_entry)
            replaced = True
        else:
            new_env.append(copy.deepcopy(item))
    if not replaced:
        new_env.append(new_entry)
    return new_env


def diff_other_keys(
    old_env: list[dict[str, Any]],
    new_env: list[dict[str, Any]],
    target: str,
) -> list[str]:
    """Return human-readable descriptions of any change to a NON-target key.

    An empty list means every other key is byte-for-byte identical. This is the
    mandatory regression check.
    """
    old = {e["name"]: e for e in normalize_env(old_env)}
    new = {e["name"]: e for e in normalize_env(new_env)}
    problems: list[str] = []

    for key in sorted(set(old) | set(new)):
        if key == target:
            continue
        o = old.get(key)
        n = new.get(key)
        if o is None and n is not None:
            problems.append(f"ADDED unexpectedly: {key} -> {json.dumps(n)}")
        elif o is not None and n is None:
            problems.append(f"REMOVED unexpectedly: {key} (was {json.dumps(o)})")
        elif o != n:
            problems.append(
                f"CHANGED unexpectedly: {key}: {json.dumps(o)} -> {json.dumps(n)}"
            )
    return problems


def summarize_entry(entry: dict[str, Any] | None) -> str:
    if entry is None:
        return "absent"
    if "secretRef" in entry:
        return f"secretRef -> {entry['secretRef']}"
    return f"literal = {entry.get('value')!r}"


# --------------------------------------------------------------------------- #
# Azure I/O (the only part that shells out)
# --------------------------------------------------------------------------- #


def _az(args: list[str]) -> str:
    proc = subprocess.run(
        ["az", *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return proc.stdout


def show_app(app: str, rg: str) -> dict[str, Any]:
    return json.loads(_az(["containerapp", "show", "-n", app, "-g", rg, "-o", "json"]))


def apply_manifest(app: str, rg: str, manifest: dict[str, Any]) -> None:
    """Write the full resource JSON to a temp YAML file and apply it.

    We serialise with json.dump — YAML is a superset of JSON, so a .yaml file
    containing valid JSON is a valid manifest, and this avoids taking a hard
    dependency on PyYAML being present on the runner.
    """
    with tempfile.NamedTemporaryFile(
        "w", suffix=".yaml", delete=False, encoding="utf-8"
    ) as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        path = fh.name
    _az(["containerapp", "update", "-n", app, "-g", rg, "--yaml", path])


# --------------------------------------------------------------------------- #
# Entrypoint
# --------------------------------------------------------------------------- #


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--app", required=True, help="Container App name")
    p.add_argument("--resource-group", required=True)
    p.add_argument("--name", required=True, help="env var name")
    p.add_argument(
        "--value",
        required=True,
        help="literal value, OR the secret name when --type=secretref",
    )
    p.add_argument("--type", dest="value_type", choices=["literal", "secretref"], required=True)
    p.add_argument("--operation", choices=["add", "update", "upsert"], default="upsert")
    p.add_argument("--container-index", type=int, default=0)
    p.add_argument(
        "--allow-type-change",
        action="store_true",
        help="explicitly permit converting literal<->secretref for the target key",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="compute + validate + print the diff but do NOT apply to Azure",
    )
    p.add_argument(
        "--summary-file",
        default=None,
        help="append a markdown report here (e.g. $GITHUB_STEP_SUMMARY)",
    )
    return p


def _emit(summary_file: str | None, text: str) -> None:
    print(text)
    if summary_file:
        with open(summary_file, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)

    manifest = show_app(args.app, args.resource_group)
    containers = manifest["properties"]["template"]["containers"]
    if args.container_index >= len(containers):
        raise SystemExit(
            f"container-index {args.container_index} out of range "
            f"({len(containers)} containers)"
        )
    container = containers[args.container_index]
    old_env = normalize_env(container.get("env"))

    before_target = find_entry(old_env, args.name)

    try:
        new_env = apply_change(
            old_env,
            name=args.name,
            value=args.value,
            value_type=args.value_type,
            operation=args.operation,
            allow_type_change=args.allow_type_change,
        )
    except ValueError as exc:
        _emit(args.summary_file, f"\n**REFUSED (policy violation):** {exc}")
        return 5

    # Mandatory regression guard.
    regressions = diff_other_keys(old_env, new_env, args.name)

    lines = [
        "## manage-gateway-env result",
        "",
        f"* app: `{args.app}`  (rg `{args.resource_group}`)",
        f"* target key: `{args.name}`",
        f"* operation: `{args.operation}`  type: `{args.value_type}`",
        f"* before: {summarize_entry(before_target)}",
        f"* after:  {summarize_entry(find_entry(new_env, args.name))}",
        f"* other keys preserved: {len(old_env)} existing "
        f"(regression check: {'PASS' if not regressions else 'FAIL'})",
    ]
    _emit(args.summary_file, "\n".join(lines))

    if regressions:
        _emit(
            args.summary_file,
            "\n**REGRESSION DETECTED — refusing to apply. "
            "The following non-target keys would change:**\n"
            + "\n".join(f"* {r}" for r in regressions),
        )
        return 2

    if args.dry_run:
        _emit(args.summary_file, "\n(dry-run — not applied)")
        return 0

    container["env"] = new_env
    apply_manifest(args.app, args.resource_group, manifest)

    # Post-apply verification: re-read from Azure and re-diff against the
    # pre-change snapshot. This catches any drift the platform itself introduced.
    live = show_app(args.app, args.resource_group)
    live_env = normalize_env(
        live["properties"]["template"]["containers"][args.container_index].get("env")
    )
    post_regressions = diff_other_keys(old_env, live_env, args.name)
    live_target = find_entry(live_env, args.name)

    _emit(
        args.summary_file,
        "\n### Post-apply verification (re-read from Azure)\n"
        f"* `{args.name}` is now: {summarize_entry(live_target)}\n"
        f"* other-key regression check: {'PASS' if not post_regressions else 'FAIL'}",
    )
    if post_regressions:
        _emit(
            args.summary_file,
            "\n**POST-APPLY REGRESSION — other keys changed after apply:**\n"
            + "\n".join(f"* {r}" for r in post_regressions),
        )
        return 3

    # Confirm the target actually landed as requested.
    expected_key = "secretRef" if args.value_type == "secretref" else "value"
    if not live_target or live_target.get(expected_key) != args.value:
        _emit(
            args.summary_file,
            f"\n**TARGET MISMATCH — expected {args.name}.{expected_key} == "
            f"{args.value!r} but live is {json.dumps(live_target)}**",
        )
        return 4

    _emit(args.summary_file, "\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
