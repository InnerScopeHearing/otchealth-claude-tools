"""Independent check of a Codex config.toml to which the script ADDED the whole aws-mcp entry (no entry existed before).

Usage: check_toml_entry.py <original.toml> <new.toml>
Exit 0 only when: both files parse with Python's own TOML parser; the new file has
mcp_servers.aws-mcp == {command: "uvx", args: [proxy, url, "--metadata", "INSTALL_SOURCE=aws-cli"],
env: {AWS_MCP_PROXY_PROFILES: "otchealth"}}; and removing that entry gives back exactly the original data.
An original file that does not exist (or is empty) counts as empty data.
"""
import copy
import os
import sys
import tomllib

EXPECTED = {
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
    if not os.path.exists(path):
        return {}
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
        print("NEW-PARSE-ERROR: %s" % e)
        return 1
    srv = new.get("mcp_servers", {}).get("aws-mcp")
    if srv != EXPECTED:
        print("ENTRY-WRONG: %r" % (srv,))
        return 1
    stripped = copy.deepcopy(new)
    del stripped["mcp_servers"]["aws-mcp"]
    if "mcp_servers" not in orig and not stripped["mcp_servers"]:
        del stripped["mcp_servers"]
    if stripped != orig:
        print("DATA-CHANGED")
        return 1
    print("OK")
    return 0


sys.exit(main())
