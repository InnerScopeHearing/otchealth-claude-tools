// plist.mjs -- reads the three build-identity fields out of an iOS Info.plist.
//
// The file is Apple's BINARY plist format (bplist00), which Node has no built-in reader for and
// this skill deliberately does not hand-roll a parser for (a binary-plist reader is real,
// fiddly-to-get-right parsing code for a one-shot need). `plutil` (macOS-only) is not available on
// this Linux toolchain; python3's stdlib `plistlib` IS available in every session this skill runs in
// and reads bplist00 natively, so it is shelled out to instead -- verified against real
// build-artifact Info.plist files (com.innerscope.aware / com.innerscope.iheartest).
import { execFileSync } from "node:child_process";

const READ_SCRIPT = `
import plistlib, json, sys
with open(sys.argv[1], "rb") as f:
    d = plistlib.load(f)
print(json.dumps({
    "CFBundleIdentifier": d.get("CFBundleIdentifier"),
    "CFBundleShortVersionString": d.get("CFBundleShortVersionString"),
    "CFBundleVersion": d.get("CFBundleVersion"),
}))
`;

/** { CFBundleIdentifier, CFBundleShortVersionString, CFBundleVersion } read from a binary or XML
 *  Info.plist at `path`. Throws (with python3's own stderr) on a malformed/missing file. */
export function readInfoPlist(path) {
  const out = execFileSync("python3", ["-c", READ_SCRIPT, path], { encoding: "utf8" });
  return JSON.parse(out);
}
