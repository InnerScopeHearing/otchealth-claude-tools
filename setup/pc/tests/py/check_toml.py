"""Independent check of a patched Codex config.toml with Python's own TOML parser.

Usage: check_toml.py <original.toml> <patched.toml>
Exit 0 only when: both files parse, the patched file has
[mcp_servers.aws-mcp.env] AWS_MCP_PROXY_PROFILES containing "otchealth",
and removing that env table gives back exactly the original data.
"""
import copy
import sys
import tomllib


def load(path):
    with open(path, "rb") as f:
        return tomllib.load(f)


def main():
    orig_path, new_path = sys.argv[1], sys.argv[2]
    try:
        orig = load(orig_path)
    except Exception as e:  # noqa: BLE001
        print("ORIGINAL-PARSE-ERROR: %s" % e)
        return 1
    try:
        new = load(new_path)
    except Exception as e:  # noqa: BLE001
        print("PATCHED-PARSE-ERROR: %s" % e)
        return 1
    srv = new.get("mcp_servers", {}).get("aws-mcp")
    if srv is None:
        print("NO-ENTRY")
        return 1
    env = srv.get("env")
    if not isinstance(env, dict) or "otchealth" not in str(env.get("AWS_MCP_PROXY_PROFILES", "")).split():
        print("ENV-MISSING: %r" % (env,))
        return 1
    stripped = copy.deepcopy(new)
    del stripped["mcp_servers"]["aws-mcp"]["env"]
    if stripped != orig:
        print("DATA-CHANGED")
        return 1
    print("OK")
    return 0


sys.exit(main())
