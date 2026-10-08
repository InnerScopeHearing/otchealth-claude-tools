"""Independent check of a patched JSON settings file with Python's own JSON parser.

Usage: check_json.py <original.json> <patched.json> <parentKey> <server> <envKey>
Exit 0 only when: both files parse, <parent>.<server>.<envKey>.AWS_MCP_PROXY_PROFILES contains "otchealth",
and removing that env block gives back exactly the original data.
"""
import copy
import json
import sys


def main():
    orig_path, new_path, parent, server, env_key = sys.argv[1:6]
    try:
        with open(orig_path, encoding="utf-8") as f:
            orig = json.load(f)
        with open(new_path, encoding="utf-8") as f:
            new = json.load(f)
    except Exception as e:  # noqa: BLE001
        print("PARSE-ERROR: %s" % e)
        return 1
    try:
        env = new[parent][server][env_key]
    except Exception as e:  # noqa: BLE001
        print("NO-ENV: %s" % e)
        return 1
    if "otchealth" not in str(env.get("AWS_MCP_PROXY_PROFILES", "")).split():
        print("ENV-WRONG: %r" % (env,))
        return 1
    stripped = copy.deepcopy(new)
    del stripped[parent][server][env_key]
    if stripped != orig:
        print("DATA-CHANGED")
        return 1
    print("OK")
    return 0


sys.exit(main())
