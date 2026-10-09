"""Checks many (original, edited) JSON settings pairs with Python's own JSON parser (used by 10-fuzz-json-vs-python.ps1).

Usage: check_json_batch.py <folder>
The folder holds pairs named  <id>-orig.json  and  <id>-new.json  (the "env" block with AWS_MCP_PROXY_PROFILES was added
to the aws-mcp entry under mcpServers). For every pair: both files must parse; mcpServers.aws-mcp.env must equal
{"AWS_MCP_PROXY_PROFILES": "otchealth"}; removing it must give back exactly the original data (so no other entry, for
example one under "projects", was touched); and the edit must be a pure insertion of one block of text.
Prints one line per problem and a final summary. Exit 0 only when there is no problem at all.
"""
import copy
import glob
import json
import os
import sys


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
    for orig_path in sorted(glob.glob(os.path.join(folder, "*-orig.json"))):
        base = orig_path[: -len("-orig.json")]
        new_path = base + "-new.json"
        name = os.path.basename(base)
        if not os.path.exists(new_path):
            continue
        try:
            with open(orig_path, "rb") as f:
                old_bytes = f.read()
            orig = json.loads(old_bytes.decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            print("%s: the ORIGINAL is not valid JSON (test generator problem): %s" % (name, e))
            problems += 1
            continue
        try:
            with open(new_path, "rb") as f:
                new_bytes = f.read()
            new = json.loads(new_bytes.decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            print("%s: the EDITED file is not valid JSON: %s" % (name, e))
            problems += 1
            continue
        env = new.get("mcpServers", {}).get("aws-mcp", {}).get("env")
        if env != {"AWS_MCP_PROXY_PROFILES": "otchealth"}:
            print("%s: the env block is wrong: %r" % (name, env))
            problems += 1
            continue
        stripped = copy.deepcopy(new)
        del stripped["mcpServers"]["aws-mcp"]["env"]
        if stripped != orig:
            print("%s: other data changed" % name)
            problems += 1
            continue
        if not pure_insertion(old_bytes, new_bytes):
            print("%s: the edit is not a pure insertion" % name)
            problems += 1
            continue
        ok += 1
    print("checked pairs ok=%d problems=%d" % (ok, problems))
    return 0 if problems == 0 else 1


sys.exit(main())
