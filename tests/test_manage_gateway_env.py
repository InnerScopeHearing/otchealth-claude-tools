#!/usr/bin/env python3
"""Unit tests for manage_gateway_env pure logic.

Each test maps to a real historical failure mode so regressions can't sneak
back in. Run: python3 -m pytest -q  (or just: python3 tests/test_manage_gateway_env.py)
"""
import copy
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import manage_gateway_env as m  # noqa: E402


def sample_env():
    # Mirrors the real gateway shape: a secretRef binding + literals.
    return [
        {"name": "OAUTH_CLIENTS", "secretRef": "oauth-clients"},
        {"name": "LOG_LEVEL", "value": "info"},
        {"name": "PORT", "value": "8080"},
    ]


# --- Failure mode #3: '@' in a literal value must be plain data ------------- #
def test_at_sign_value_is_plain_data():
    env = sample_env()
    new = m.apply_change(
        env, name="GRAPH_DRIVE_USER", value="matthew@innd.com",
        value_type="literal", operation="upsert", allow_type_change=False,
    )
    entry = m.find_entry(new, "GRAPH_DRIVE_USER")
    assert entry == {"name": "GRAPH_DRIVE_USER", "value": "matthew@innd.com"}
    # input not mutated
    assert m.find_entry(env, "GRAPH_DRIVE_USER") is None


# --- Failure mode #2: never clobber a secretRef with a literal ------------- #
def test_refuses_secretref_to_literal_without_optin():
    env = sample_env()
    try:
        m.apply_change(
            env, name="OAUTH_CLIENTS", value="[]",
            value_type="literal", operation="upsert", allow_type_change=False,
        )
    except ValueError as e:
        assert "secretref" in str(e).lower()
    else:
        raise AssertionError("expected refusal converting secretRef -> literal")


def test_allows_type_change_when_explicit():
    env = sample_env()
    new = m.apply_change(
        env, name="OAUTH_CLIENTS", value="literal-now",
        value_type="literal", operation="upsert", allow_type_change=True,
    )
    assert m.find_entry(new, "OAUTH_CLIENTS") == {
        "name": "OAUTH_CLIENTS", "value": "literal-now"}


def test_secretref_update_preserves_binding_semantics():
    env = sample_env()
    new = m.apply_change(
        env, name="OAUTH_CLIENTS", value="oauth-clients",
        value_type="secretref", operation="update", allow_type_change=False,
    )
    assert m.find_entry(new, "OAUTH_CLIENTS") == {
        "name": "OAUTH_CLIENTS", "secretRef": "oauth-clients"}


# --- Failure mode #1: JSON-array literal survives intact -------------------- #
def test_json_array_value_survives():
    env = sample_env()
    payload = '[{"client_id":"a","redirect":"https://x/y?z=1&w=2"}]'
    new = m.apply_change(
        env, name="OAUTH_CLIENTS", value=payload,
        value_type="literal", operation="upsert", allow_type_change=True,
    )
    assert m.find_entry(new, "OAUTH_CLIENTS")["value"] == payload


# --- Failure mode #5: regression guard catches collateral change ----------- #
def test_regression_guard_clean_when_only_target_changes():
    env = sample_env()
    new = m.apply_change(
        env, name="GRAPH_DRIVE_USER", value="matthew@innd.com",
        value_type="literal", operation="add", allow_type_change=False,
    )
    assert m.diff_other_keys(env, new, "GRAPH_DRIVE_USER") == []


def test_regression_guard_detects_collateral_change():
    env = sample_env()
    tampered = copy.deepcopy(env)
    tampered.append({"name": "GRAPH_DRIVE_USER", "value": "matthew@innd.com"})
    # simulate the classic bug: OAUTH_CLIENTS secretRef got flattened to a value
    for e in tampered:
        if e["name"] == "OAUTH_CLIENTS":
            del e["secretRef"]
            e["value"] = ""
    problems = m.diff_other_keys(env, tampered, "GRAPH_DRIVE_USER")
    assert any("OAUTH_CLIENTS" in p for p in problems)


def test_regression_guard_detects_removed_key():
    env = sample_env()
    new = [e for e in env if e["name"] != "LOG_LEVEL"]
    new.append({"name": "GRAPH_DRIVE_USER", "value": "matthew@innd.com"})
    problems = m.diff_other_keys(env, new, "GRAPH_DRIVE_USER")
    assert any("LOG_LEVEL" in p and "REMOVED" in p for p in problems)


# --- operation semantics --------------------------------------------------- #
def test_add_refuses_existing():
    env = sample_env()
    try:
        m.apply_change(env, name="LOG_LEVEL", value="debug",
                       value_type="literal", operation="add",
                       allow_type_change=False)
    except ValueError as e:
        assert "already exists" in str(e)
    else:
        raise AssertionError("add should refuse an existing key")


def test_update_refuses_absent():
    env = sample_env()
    try:
        m.apply_change(env, name="NOPE", value="x",
                       value_type="literal", operation="update",
                       allow_type_change=False)
    except ValueError as e:
        assert "does not exist" in str(e)
    else:
        raise AssertionError("update should refuse an absent key")


def test_normalize_drops_nulls():
    raw = [{"name": "A", "value": "1", "secretRef": None}]
    assert m.normalize_env(raw) == [{"name": "A", "value": "1"}]


if __name__ == "__main__":
    funcs = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in funcs:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(funcs) - failed}/{len(funcs)} passed")
    sys.exit(1 if failed else 0)
