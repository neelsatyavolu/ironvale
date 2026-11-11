"""Builds the M7 rifle from nothing: mesh, UVs, baked textures and a GLB.

Run headless through scripts/process-gun-m7.mjs, or directly:
  blender -b -t 4 --factory-startup -P scripts/blender/build-m7.py -- <output folder> [--preview] [--scale 0.25]

Writes m7-raw.glb (five part objects, three untextured materials) and, unless
--preview is given, <set>_color.png, <set>_normal.png and <set>_orm.png for
each texture set. --scale shrinks the textures for a quick trial bake.
"""
import json
import os
import sys
import time

import bpy

# Keep compiled files out of the repository.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import m7_bake  # noqa: E402
import m7_lib  # noqa: E402
import m7_parts  # noqa: E402


def main() -> None:
    arguments = sys.argv[sys.argv.index("--") + 1 :]
    folder = os.path.abspath(arguments[0])
    preview = "--preview" in arguments
    scale = float(arguments[arguments.index("--scale") + 1]) if "--scale" in arguments else 1.0
    os.makedirs(folder, exist_ok=True)
    started = time.time()
    times = {}

    def lap(label: str) -> None:
        times[label] = round(time.time() - started, 1)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    m7_parts.build_all()
    lap("mesh")
    gun = m7_bake.merge(m7_lib.built)
    if not preview:
        m7_bake.unwrap(gun)
        lap("unwrap")
        m7_bake.bake(gun, folder, scale)
        lap("bake")
    triangles = m7_bake.export(gun, m7_parts.PIVOTS, os.path.join(folder, "m7-raw.glb"))
    lap("export")
    with open(os.path.join(folder, "build.json"), "w", encoding="utf-8") as report:
        json.dump({"triangles": triangles, "total": sum(triangles.values()), "seconds": times}, report, indent=2)
    sys.stdout.write(f"m7: {sum(triangles.values())} triangles {triangles} in {times}\n")


main()
