"""Export a placed model to a self-contained GLB the browser can show."""
import bpy
import os
import sys


def argv_after_double_dash():
    if "--" in sys.argv:
        return sys.argv[sys.argv.index("--") + 1 :]
    return []


def open_blend(path):
    bpy.ops.wm.open_mainfile(filepath=path)


def append_or_import(path):
    lower = path.lower()
    if lower.endswith(".blend"):
        open_blend(path)
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if lower.endswith(".glb") or lower.endswith(".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif lower.endswith(".obj"):
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise SystemExit(f"unsupported model {path}")


def main():
    args = argv_after_double_dash()
    if len(args) < 2:
        raise SystemExit("usage: preview_glb.py -- src out.glb")
    src, out = args[0], args[1]
    if not os.path.isfile(src):
        raise SystemExit(f"missing {src}")
    append_or_import(src)
    for obj in list(bpy.data.objects):
        if obj.type in {"CAMERA", "LIGHT"}:
            bpy.data.objects.remove(obj, do_unlink=True)
    if not any(o.type == "MESH" for o in bpy.data.objects):
        raise SystemExit("no mesh in file")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB")
    print("preview wrote", out)


if __name__ == "__main__":
    main()
