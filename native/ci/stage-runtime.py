#!/usr/bin/env python3
"""Copies everything the app reads at run time into its bundle, so it never opens a file in the repository.

Called by the "Stage runtime data" build phase (native/IronvaleApp/project.yml):

    stage-runtime.py REPO RESOURCES

writes, under RESOURCES (the app's Contents/Resources):

    Contract/                      native/Contract (ContractLocation and CharacterTables look here first)
    Runtime/                       a repository-shaped tree; the app's repository root (RuntimeRoot.bundled)
      native/MapPackages/<map>/    meta.json, collision/boundary/bvh binaries, render/ (fixtures/ is test-only)
      native/MapPackages/guns/     the gun-export GLBs and their JSON
      native/BakedAssets/          baked character IVM data
      assets/*.json                the asset manifests (SoundLibrary, MapAssets.assetFile)
      src/audio/sound-meta.json    sound loop points (SoundLibrary)
      public/assets/...            only the files a map package, a map's sky or the sound manifest names,
                                   plus the allowlisted first-party weapons/ pictures (PLAN.md 3.5)
      bundle-manifest.json         every staged public/ file with its manifest id, licence and SHA-256
    Licenses/                      third-party licence texts the Credits screen shows

The licence gate (PLAN.md 3.5, M12): every staged public/ file must belong to a manifest entry whose licence
is CC0 or CC-BY 4.0, or sit under an allowlisted first-party folder; anything else fails the build.
Copies are incremental (size and mtime); files that are no longer staged are removed.
"""
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

ALLOWED_LICENCES = {"CC0", "CC-BY 4.0"}
FIRST_PARTY = ("assets/weapons/",)  # PLAN.md 3.5: explicit allowlist next to the manifests
MANAGED = ("Contract", "Runtime", "Licenses")


def fail(message):
    print(f"error: stage-runtime: {message}", file=sys.stderr)
    sys.exit(1)


def files_under(root, skip_dirs=()):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in skip_dirs)
        for name in sorted(filenames):
            if not name.startswith("."):
                yield Path(dirpath, name)


def strings_in(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings_in(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings_in(item)


def load_manifests(repo):
    """id -> entry, and 'dl/<path>' / 'local/<path>' -> entry."""
    by_id, by_file = {}, {}
    for path in sorted((repo / "assets").glob("*.json")):
        for entry in json.loads(path.read_text())["assets"]:
            by_id[entry["id"]] = entry
            for file in (entry.get("files") or {}).values():
                if isinstance(file, dict) and "path" in file:
                    by_file[("local/" if file.get("local") else "dl/") + file["path"]] = entry
    return by_id, by_file


def public_files(repo, by_id):
    """Repo-relative public/ files the runtime opens, each with the reason it is needed."""
    wanted = {}
    packages = repo / "native/MapPackages"
    for meta_path in sorted(packages.glob("*/meta.json")):
        meta = json.loads(meta_path.read_text())
        # MapRenderer: the environment (hdr@2k) and the sky panorama of every hdri the map names.
        for value in strings_in(meta):
            entry = by_id.get(value)
            if entry and entry["kind"] == "hdri":
                for key in ("hdr@2k", "sky"):
                    wanted[f"public/assets/dl/{entry['files'][key]['path']}"] = f"{meta_path.parent.name} sky"
        # MapRenderer / ProgramTextures: 'url' textures are public/-relative.
        for scene in sorted((meta_path.parent / "render").glob("*.json")):
            for value in strings_in(json.loads(scene.read_text())):
                if value.startswith("assets/") and (repo / "public" / value).is_file():
                    wanted[f"public/{value}"] = f"{meta_path.parent.name} render"
    # SoundLibrary: every snd- entry of assets/sounds.json.
    for entry in json.loads((repo / "assets/sounds.json").read_text())["assets"]:
        audio = (entry.get("files") or {}).get("audio")
        if entry["id"].startswith("snd-") and audio:
            wanted[f"public/assets/{'local' if audio.get('local') else 'dl'}/{audio['path']}"] = "sound"
    # HUDView: the weapon picker's pictures.
    for path in files_under(repo / "public/assets/weapons"):
        wanted[str(path.relative_to(repo))] = "weapon picture"
    return wanted


def licence_gate(wanted, by_file):
    records, problems = [], []
    for rel in sorted(wanted):
        inner = rel[len("public/"):]
        if inner.startswith(FIRST_PARTY):
            records.append({"path": rel, "asset": None, "license": "first-party"})
            continue
        entry = by_file.get(inner[len("assets/"):])
        if entry is None:
            problems.append(f"{rel} belongs to no manifest entry and no allowlisted folder")
        elif entry["license"] not in ALLOWED_LICENCES:
            problems.append(f"{rel} ({entry['id']}) has licence {entry['license']!r}")
        else:
            records.append({"path": rel, "asset": entry["id"], "license": entry["license"]})
    if problems:
        fail("licence gate:\n  " + "\n  ".join(problems))
    return records


def plan(repo, app_resources_src):
    """dest (relative to RESOURCES) -> source path."""
    copies = {}
    for src in files_under(repo / "native/Contract"):
        copies[f"Contract/{src.relative_to(repo / 'native/Contract')}"] = src
    for src in files_under(repo / "native/MapPackages", skip_dirs=("fixtures",)):
        copies[f"Runtime/{src.relative_to(repo)}"] = src
    for src in files_under(repo / "native/BakedAssets"):
        copies[f"Runtime/{src.relative_to(repo)}"] = src
    for src in sorted((repo / "assets").glob("*.json")):
        copies[f"Runtime/{src.relative_to(repo)}"] = src
    copies["Runtime/src/audio/sound-meta.json"] = repo / "src/audio/sound-meta.json"
    for src in files_under(app_resources_src / "Licenses"):
        copies[f"Licenses/{src.name}"] = src
    return copies


def check_inputs(repo):
    packages = repo / "native/MapPackages"
    maps = [p.parent.name for p in sorted(packages.glob("*/meta.json"))]
    if not maps:
        fail(f"no map packages under {packages}")
    for name in maps:
        if not (packages / name / "render/scene.json").is_file():
            fail(f"{packages / name}/render is missing; run native/Tools/map-export first")
    for need in ("native/Contract/contract.lock", "native/BakedAssets", "assets/sounds.json", "src/audio/sound-meta.json"):
        if not (repo / need).exists():
            fail(f"{repo / need} is missing")


def copy_if_changed(src, dst):
    s = src.stat()
    try:
        d = dst.stat()
        if d.st_size == s.st_size and int(d.st_mtime) == int(s.st_mtime):
            return False
    except FileNotFoundError:
        dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return True


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    if len(sys.argv) != 3:
        fail("usage: stage-runtime.py REPO RESOURCES")
    repo, resources = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
    check_inputs(repo)
    by_id, by_file = load_manifests(repo)
    wanted = public_files(repo, by_id)
    missing = [rel for rel in wanted if not (repo / rel).is_file()]
    if missing:
        fail("missing public files (download the web assets first):\n  " + "\n  ".join(sorted(missing)[:20]))
    records = licence_gate(wanted, by_file)
    copies = plan(repo, repo / "native/IronvaleApp/Resources")
    for rel in wanted:
        copies[f"Runtime/{rel}"] = repo / rel

    changed = sum(copy_if_changed(src, resources / dest) for dest, src in copies.items())
    removed = 0
    for top in MANAGED:
        for path in list(files_under(resources / top)) if (resources / top).exists() else []:
            rel = str(path.relative_to(resources))
            if rel not in copies and rel != "Runtime/bundle-manifest.json":
                path.unlink()
                removed += 1

    for record in records:
        record["sha256"] = sha256(resources / "Runtime" / record["path"])
    manifest = {"files": records, "licences": sorted({r["license"] for r in records})}
    out = resources / "Runtime/bundle-manifest.json"
    text = json.dumps(manifest, indent=1, sort_keys=True) + "\n"
    if not out.exists() or out.read_text() != text:
        out.write_text(text)
    size = sum(src.stat().st_size for src in copies.values())
    print(f"stage-runtime: {len(copies)} files ({size / 1e6:.0f} MB), {changed} copied, {removed} removed, "
          f"{len(records)} public files through the licence gate")


if __name__ == "__main__":
    main()
