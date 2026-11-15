#!/usr/bin/env python3
"""Typecheck this Xcode target without compiling assets, signing or installing."""
import json
import subprocess
import tempfile
from pathlib import Path

base = Path(__file__).resolve().parent / "ANCRelay"
project = json.loads(subprocess.check_output([
    "plutil", "-convert", "json", "-o", "-", str(base / "ANCRelay.xcodeproj/project.pbxproj")
]))
objects = project["objects"]
target = next(x for x in objects.values() if x.get("isa") == "PBXNativeTarget" and x.get("name") == "ANCRelay")
sources = []
for phase_id in target["buildPhases"]:
    phase = objects[phase_id]
    if phase["isa"] != "PBXSourcesBuildPhase":
        continue
    for build_id in phase["files"]:
        ref = objects[objects[build_id]["fileRef"]]
        if ref["path"].endswith(".swift"):
            source = (base / ref["path"]).resolve()
            if not source.is_file():
                raise SystemExit(f"Missing source: {source}")
            sources.append(str(source))
if not sources:
    raise SystemExit("No Swift sources in Xcode target")
sdk = subprocess.check_output(["xcrun", "--sdk", "iphoneos", "--show-sdk-path"], text=True).strip()
with tempfile.TemporaryDirectory(prefix="anc-iphone-source-") as cache:
    subprocess.run(["xcrun", "--sdk", "iphoneos", "swiftc", "-typecheck", "-parse-as-library",
        "-swift-version", "5", "-module-name", "ANCRelay", "-target", "arm64-apple-ios17.0",
        "-sdk", sdk, "-module-cache-path", cache, *sources], check=True)
print(f"PASS: {len(sources)} Xcode target Swift files typechecked against iPhone SDK; not an App build or device test.")
