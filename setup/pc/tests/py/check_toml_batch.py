"""Checks many (original, edited) config.toml pairs with Python's own TOML parser (used by 09-fuzz-toml-vs-python.ps1).

Usage: check_toml_batch.py <folder>
The folder holds pairs named  <id>-orig.toml  and  <id>-entry.toml  (the whole aws-mcp entry was added to a file
that had none)  or  <id>-env.toml  (the env table was added to an existing aws-mcp entry).
For every pair: both files must parse; the aws-mcp entry must be right; removing what was added must give back exactly
the original data; and the edit must be a pure insertion (the original text, byte for byte, is the new text minus one block).
Prints one line per problem and a final summary. Exit 0 only when there is no problem at all.
"""
import copy
import glob
import os
import sys
import tomllib

ENTRY = {
    "command": "uvx",
    "args": [
        "mcp-proxy-for-aws@latest",
        "https://aws-mcp.us-east-1.api.aws/mcp",
        "--metadata",
        "INSTALL_SOURCE=aws-cli",
    ],
    "env": {"AWS_MCP_PROXY_PROFILES": "otchealth"},
}


def load(path):
    with open(path, "rb") as f:
        return tomllib.load(f)


def pure_insertion(old: bytes, new: bytes) -> bool:
    if len(new) < len(old):
        return False
    i = 0
    while i < len(old) and old[i] == new[i]:
        i += 1
    j = 0
    while j < len(old) - i and old[-1 - j] == new[-1 - j]:
        j += 1
    return i + j >= len(old)


def main():
    folder = sys.argv[1]
    ok = 0
    problems = 0
    for orig_path in sorted(glob.glob(os.path.join(folder, "*-orig.toml"))):
        base = orig_path[: -len("-orig.toml")]
        name = os.path.basename(base)
        if os.path.exists(base + "-entry.toml"):
            kind, new_path = "entry", base + "-entry.toml"
        elif os.path.exists(base + "-env.toml"):
            kind, new_path = "env", base + "-env.toml"
        else:
            continue
        try:
            orig = load(orig_path)
        except Exception as e:  # noqa: BLE001
            print("%s: the ORIGINAL is not valid TOML (test generator problem): %s" % (name, e))
            problems += 1
            continue
        try:
            new = load(new_path)
        except Exception as e:  # noqa: BLE001
            print("%s: the EDITED file is not valid TOML: %s" % (name, e))
            problems += 1
            continue
        srv = new.get("mcp_servers", {}).get("aws-mcp")
        stripped = copy.deepcopy(new)
        if kind == "entry":
            if srv != ENTRY:
                print("%s: the entry is wrong: %r" % (name, srv))
                problems += 1
                continue
            del stripped["mcp_servers"]["aws-mcp"]
            if "mcp_servers" not in orig and not stripped["mcp_servers"]:
                del stripped["mcp_servers"]
        else:
            env = (srv or {}).get("env")
            if not isinstance(env, dict) or "otchealth" not in str(env.get("AWS_MCP_PROXY_PROFILES", "")).split():
                print("%s: the env setting is missing: %r" % (name, env))
                problems += 1
                continue
            del stripped["mcp_servers"]["aws-mcp"]["env"]
        if stripped != orig:
            print("%s: other data changed" % name)
            problems += 1
            continue
        with open(orig_path, "rb") as f:
            old_bytes = f.read()
        with open(new_path, "rb") as f:
            new_bytes = f.read()
        if not pure_insertion(old_bytes, new_bytes):
            print("%s: the edit is not a pure insertion" % name)
            problems += 1
            continue
        if kind == "entry" and not new_bytes.startswith(old_bytes):
            print("%s: the original text is not kept in front of the added entry" % name)
            problems += 1
            continue
        ok += 1
    print("checked pairs ok=%d problems=%d" % (ok, problems))
    return 0 if problems == 0 else 1


sys.exit(main())
