"""
Assemble an environment plate from library assets (HDRI / props / image plane).
Usage (via worker):
  blender -b -P assemble.py -- out.png /path/to/config.json

config.json:
  {
    "hdri": "/abs/path.hdr",
    "props": ["/abs/model.glb"],
    "planeImage": "/abs/still.jpg",
    "camera": { "loc": [0, -6, 1.6], "rot_deg": [80, 0, 0] },
    "samples": 32
  }
Missing assets fall back to a simple void + soft light (still Cycles).
"""
import bpy
import json
import math
import os
import sys


def argv_after_double_dash():
    if "--" in sys.argv:
        return sys.argv[sys.argv.index("--") + 1 :]
    return []


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.meshes) + list(bpy.data.materials) + list(bpy.data.lights):
        if block.users == 0:
            if isinstance(block, bpy.types.Mesh):
                bpy.data.meshes.remove(block)
            elif isinstance(block, bpy.types.Material):
                bpy.data.materials.remove(block)
            elif isinstance(block, bpy.types.Light):
                bpy.data.lights.remove(block)


def setup_world_hdri(path):
    world = bpy.data.worlds.new("AssembleWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputWorld")
    bg = nodes.new("ShaderNodeBackground")
    if path and os.path.isfile(path):
        env = nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(path)
        links.new(env.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = 1.0
    else:
        bg.inputs["Color"].default_value = (0.02, 0.03, 0.05, 1)
        bg.inputs["Strength"].default_value = 0.4
    links.new(bg.outputs["Background"], out.inputs["Surface"])


def add_floor():
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
    floor = bpy.context.active_object
    mat = bpy.data.materials.new("FloorMat")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.12, 0.12, 0.14, 1)
        bsdf.inputs["Roughness"].default_value = 0.55
    floor.data.materials.append(mat)
    return floor


def face_upright(plane, loc, toward):
    import mathutils

    dest = toward or (loc[0], loc[1] - 1, loc[2])
    direction = mathutils.Vector((dest[0] - loc[0], dest[1] - loc[1], 0.0))
    if direction.length < 1e-4:
        direction = mathutils.Vector((0.0, -1.0, 0.0))
    # Plane normal is local +Z. Aim that at the camera and keep the card upright.
    plane.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()


def add_image_plane(path, loc=(0, 0.2, 1.2), size=2.2, name="ImagePlane", face=None):
    if not path or not os.path.isfile(path):
        return None
    bpy.ops.mesh.primitive_plane_add(size=size, location=loc)
    plane = bpy.context.active_object
    plane.name = name
    face_upright(plane, loc, face)
    mat = bpy.data.materials.new(f"Mat_{name}")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    tex = nodes.new("ShaderNodeTexImage")
    try:
        tex.image = bpy.data.images.load(path)
        # Keep aspect roughly: scale X by image ratio
        w, h = tex.image.size[0], tex.image.size[1]
        if w and h:
            aspect = float(w) / float(h)
            plane.scale.x = aspect
    except Exception:
        return plane
    if bsdf:
        links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        # Match the studio viewport: the card is a screen, not a lit poster.
        if "Emission Color" in bsdf.inputs:
            links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
            if "Emission Strength" in bsdf.inputs:
                bsdf.inputs["Emission Strength"].default_value = 1.2
        elif "Emission" in bsdf.inputs:
            links.new(tex.outputs["Color"], bsdf.inputs["Emission"])
    plane.data.materials.append(mat)
    return plane


def add_layered_planes(paths):
    """Place stills as stacked layers in empty space (front → back)."""
    planes = [p for p in (paths or []) if p]
    if not planes:
        return
    n = len(planes)
    # Spread along Y (depth) and slight X offset so layers read clearly
    for i, path in enumerate(planes):
        t = i / max(n - 1, 1)
        y = 0.4 + i * 1.15
        x = (i - (n - 1) / 2.0) * 0.35
        z = 1.35 + (0.15 if i % 2 else 0)
        size = 2.4 - t * 0.35
        add_image_plane(path, loc=(x, y, z), size=size, name=f"Layer_{i+1}")


def seat_group(objs, loc):
    """Sit the imported mesh on loc, bottom-center, without moving the studio camera."""
    import mathutils

    roots = [o for o in objs if o.parent not in objs]
    if not roots:
        return
    mins = [1e9, 1e9, 1e9]
    maxs = [-1e9, -1e9, -1e9]
    found = False
    for obj in objs:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            world = obj.matrix_world @ mathutils.Vector(corner)
            for i in range(3):
                mins[i] = min(mins[i], world[i])
                maxs[i] = max(maxs[i], world[i])
            found = True
    if not found:
        for obj in roots:
            obj.location = loc
        return
    dx = float(loc[0]) - (mins[0] + maxs[0]) / 2
    dy = float(loc[1]) - (mins[1] + maxs[1]) / 2
    dz = float(loc[2]) - mins[2]
    for obj in roots:
        obj.location.x += dx
        obj.location.y += dy
        obj.location.z += dz


def append_blend(path):
    before = set(bpy.data.objects)
    with bpy.data.libraries.load(path, link=False) as (data_from, data_to):
        data_to.objects = list(data_from.objects)
    keep = {"MESH", "EMPTY", "CURVE", "SURFACE", "META", "FONT", "ARMATURE"}
    imported = []
    for obj in data_to.objects:
        if obj is None or obj.type not in keep:
            continue
        try:
            bpy.context.collection.objects.link(obj)
        except RuntimeError:
            pass
        imported.append(obj)
    # Drop cameras/lights that libraries.load may have left unlinked in data.
    for obj in list(bpy.data.objects):
        if obj not in before and obj not in imported and obj.type in {"CAMERA", "LIGHT"}:
            bpy.data.objects.remove(obj, do_unlink=True)
    return imported


def import_prop(path, loc=None):
    if not path or not os.path.isfile(path):
        return []
    lower = path.lower()
    before = set(bpy.data.objects)
    try:
        if lower.endswith(".blend"):
            imported = append_blend(path)
        elif lower.endswith(".glb") or lower.endswith(".gltf"):
            bpy.ops.import_scene.gltf(filepath=path)
            imported = [o for o in bpy.data.objects if o not in before]
        elif lower.endswith(".obj"):
            bpy.ops.wm.obj_import(filepath=path)
            imported = [o for o in bpy.data.objects if o not in before]
        else:
            return []
    except Exception as e:
        print("prop import failed", path, e)
        return []
    if loc is not None and imported:
        seat_group(imported, loc)
    return imported


def lerp_vec(a, b, u):
    return [a[i] + (b[i] - a[i]) * u for i in range(3)]

def lerp_float(a, b, u):
    return a + (b - a) * u

def setup_camera(cfg):
    cam_data = bpy.data.cameras.new("AssembleCam")
    cam = bpy.data.objects.new("AssembleCam", cam_data)
    bpy.context.collection.objects.link(cam)
    cfg = cfg or {}
    track = cfg.get("track")
    if track and len(track) >= 2:
        loc = track[0].get("position") or {}
        cam.location = (float(loc.get("x") or 0), float(loc.get("y") or 0), float(loc.get("z") or 0))
        tgt = track[0].get("target") or {}
        direction = (
            float(tgt.get("x") or 0) - cam.location[0],
            float(tgt.get("y") or 0) - cam.location[1],
            float(tgt.get("z") or 1) - cam.location[2],
        )
        cam.rotation_euler = direction_to_euler(direction)
        fov = track[0].get("fov") or 40
        cam_data.angle = math.radians(float(fov))
        for i, kf in enumerate(track):
            frame = max(1, int(round(float(kf.get("t") or 0) * 12)) + 1)
            pos = kf.get("position") or {}
            cam.location = (float(pos.get("x") or 0), float(pos.get("y") or 0), float(pos.get("z") or 0))
            cam.keyframe_insert(data_path="location", frame=frame)
            targ = kf.get("target") or {}
            direction = (
                float(targ.get("x") or 0) - cam.location[0],
                float(targ.get("y") or 0) - cam.location[1],
                float(targ.get("z") or 1) - cam.location[2],
            )
            cam.rotation_euler = direction_to_euler(direction)
            cam.keyframe_insert(data_path="rotation_euler", frame=frame)
    else:
        loc = cfg.get("loc") or [0, -7.2, 1.85]
        cam.location = tuple(loc)
        if cfg.get("fov"):
            cam_data.lens = 50
            cam_data.angle = math.radians(float(cfg["fov"]))
        target = cfg.get("target")
        if target and len(target) == 3:
            direction = (
                float(target[0]) - float(loc[0]),
                float(target[1]) - float(loc[1]),
                float(target[2]) - float(loc[2]),
            )
            cam.rotation_euler = direction_to_euler(direction)
        else:
            rot = cfg.get("rot_deg") or [78, 0, 0]
            cam.rotation_euler = tuple(math.radians(r) for r in rot)
    bpy.context.scene.camera = cam
    return cam


def direction_to_euler(direction):
    import mathutils

    vec = mathutils.Vector(direction)
    if vec.length < 1e-6:
        return (math.radians(80), 0, 0)
    return vec.to_track_quat("-Z", "Y").to_euler()


def add_lights(lights):
    rows = lights or []
    if not rows:
        data = bpy.data.lights.new(name="Fill", type="POINT")
        data.energy = 80
        obj = bpy.data.objects.new("Fill", data)
        bpy.context.collection.objects.link(obj)
        obj.location = (0, -2, 3)
        return
    for i, spec in enumerate(rows):
        pos = spec.get("position") or {}
        tgt = spec.get("target") or {}
        kind = str(spec.get("type") or "point").lower()
        btype = "POINT"
        if kind == "sun":
            btype = "SUN"
        elif kind == "spot":
            btype = "SPOT"
        elif kind == "area":
            btype = "AREA"
        data = bpy.data.lights.new(name=f"Light_{i}", type=btype)
        energy = float(spec.get("intensity") or 800)
        if btype == "SUN":
            data.energy = max(0.1, min(energy, 20) if energy <= 20 else energy / 100.0)
        elif btype == "AREA":
            data.energy = max(energy, 20)
            size = float(spec.get("size") or 2)
            data.size = size
            data.shape = "SQUARE"
        elif btype == "SPOT":
            data.energy = max(energy, 50)
            angle = float(spec.get("angle") or 40)
            data.spot_size = math.radians(max(5.0, min(90.0, angle)))
            data.spot_blend = 0.25
        else:
            data.energy = max(energy, 50)
        color = spec.get("color") or "#ffffff"
        if isinstance(color, str) and color.startswith("#") and len(color) >= 7:
            data.color = (
                int(color[1:3], 16) / 255,
                int(color[3:5], 16) / 255,
                int(color[5:7], 16) / 255,
            )
        obj = bpy.data.objects.new(f"Light_{i}", data)
        bpy.context.collection.objects.link(obj)
        obj.location = (float(pos.get("x") or 0), float(pos.get("y") or 0), float(pos.get("z") or 2))
        if btype in {"SUN", "SPOT", "AREA"}:
            # Aim -Z toward target (Blender lights point down -Z by default).
            import mathutils

            aim = mathutils.Vector(
                (
                    float(tgt.get("x") or 0) - obj.location.x,
                    float(tgt.get("y") or 0) - obj.location.y,
                    float(tgt.get("z") or 1) - obj.location.z,
                )
            )
            if aim.length > 1e-6:
                obj.rotation_euler = aim.to_track_quat("-Z", "Y").to_euler()


def set_object_opacity(objs, opacity=1.0):
    alpha = max(0.0, min(1.0, float(opacity)))
    for ob in objs:
        if not getattr(ob, "material_slots", None):
            continue
        for slot in ob.material_slots:
            mat = slot.material
            if not mat:
                continue
            mat.use_nodes = True
            bsdf = mat.node_tree.nodes.get("Principled BSDF")
            if bsdf and "Alpha" in bsdf.inputs:
                bsdf.inputs["Alpha"].default_value = alpha
            if alpha < 0.999:
                try:
                    mat.blend_method = "BLEND"
                except Exception:
                    pass


def apply_timeline_visibility(objs, timeline_range, fps=12, frames=1):
    if not timeline_range:
        return
    in_sec = float(timeline_range.get("inSec") or 0)
    out_sec = float(timeline_range.get("outSec") or 0)
    in_frame = max(1, int(round(in_sec * fps)) + 1)
    out_frame = max(in_frame + 1, int(round(out_sec * fps)) + 1) if out_sec > in_sec else frames + 1
    for ob in objs:
        ob.hide_render = True
        ob.keyframe_insert(data_path="hide_render", frame=1)
        ob.hide_render = False
        ob.keyframe_insert(data_path="hide_render", frame=in_frame)
        if out_frame <= frames + 1:
            ob.hide_render = True
            ob.keyframe_insert(data_path="hide_render", frame=out_frame)


def apply_animation(objs, animation, fps=12, frames=1):
    if not animation:
        return
    keys = animation.get("keyframes") or []
    if not keys:
        return
    loop = bool(animation.get("loop"))
    max_t = float(keys[-1].get("t") or 0)
    repeats = 1
    if loop and max_t > 0:
        repeats = max(1, int(math.ceil((frames / fps) / max_t)) + 1)
    for rep in range(repeats):
        base = rep * max_t
        for kf in keys:
            t = float(kf.get("t") or 0) + base
            frame = max(1, int(round(t * fps)) + 1)
            if frame > frames + 2:
                continue
            pos = kf.get("position")
            rot = kf.get("rotation")
            scl = kf.get("scale")
            opacity = kf.get("opacity")
            for ob in objs:
                if pos:
                    ob.location = (
                        float(pos.get("x") or ob.location.x),
                        float(pos.get("y") or ob.location.y),
                        float(pos.get("z") or ob.location.z),
                    )
                    ob.keyframe_insert(data_path="location", frame=frame)
                if rot:
                    import mathutils

                    ob.rotation_euler = mathutils.Euler(
                        (
                            math.radians(float(rot.get("x") or 0)),
                            math.radians(float(rot.get("y") or 0)),
                            math.radians(float(rot.get("z") or 0)),
                        ),
                        "XYZ",
                    )
                    ob.keyframe_insert(data_path="rotation_euler", frame=frame)
                if scl:
                    ob.scale = (
                        float(scl.get("x") or 1),
                        float(scl.get("y") or 1),
                        float(scl.get("z") or 1),
                    )
                    ob.keyframe_insert(data_path="scale", frame=frame)
                if opacity is not None:
                    set_object_opacity([ob], opacity)
                    for slot in ob.material_slots:
                        mat = slot.material
                        if not mat or not mat.use_nodes:
                            continue
                        bsdf = mat.node_tree.nodes.get("Principled BSDF")
                        if bsdf and "Alpha" in bsdf.inputs:
                            bsdf.inputs["Alpha"].keyframe_insert("default_value", frame=frame)


def place_objects(objects, face=None, fps=12, frames=1):
    for i, spec in enumerate(objects or []):
        if spec.get("visible") is False:
            continue
        path = spec.get("path")
        pos = spec.get("position") or {}
        loc = (float(pos.get("x") or 0), float(pos.get("y") or 0), float(pos.get("z") or 1.2))
        kind = spec.get("kind") or ""
        imported = []
        if kind == "model" or str(path or "").lower().endswith((".glb", ".gltf", ".obj", ".blend")):
            imported = import_prop(path, loc=loc) or []
        else:
            plane = add_image_plane(path, loc=loc, size=2.2, name=f"Obj_{i}", face=face)
            if plane:
                imported = [plane]
        if not imported:
            continue
        rot = spec.get("rotation") or {}
        scl = spec.get("scale") or {}
        for ob in imported:
            if rot:
                import mathutils

                ob.rotation_euler = mathutils.Euler(
                    (
                        math.radians(float(rot.get("x") or 0)),
                        math.radians(float(rot.get("y") or 0)),
                        math.radians(float(rot.get("z") or 0)),
                    ),
                    "XYZ",
                )
            if scl:
                ob.scale = (
                    float(scl.get("x") or 1) * ob.scale.x,
                    float(scl.get("y") or 1) * ob.scale.y,
                    float(scl.get("z") or 1) * ob.scale.z,
                )
        set_object_opacity(imported, spec.get("opacity", 1.0))
        apply_timeline_visibility(imported, spec.get("timelineRange"), fps=fps, frames=frames)
        apply_animation(imported, spec.get("animation"), fps=fps, frames=frames)


def main():
    args = argv_after_double_dash()
    out_png = args[0] if args else "/tmp/assemble.png"
    cfg_path = args[1] if len(args) > 1 else None
    cfg = {}
    if cfg_path and os.path.isfile(cfg_path):
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)

    clear_scene()
    setup_world_hdri(cfg.get("hdri"))
    if not cfg.get("void"):
        add_floor()
    objects = cfg.get("objects") or []
    cam = cfg.get("camera") or {}
    cam_loc = (cam.get("loc") or [0, -6, 2])[:3]
    frames = int(cfg.get("frames") or 1)
    track = (cfg.get("camera") or {}).get("track") or []
    if frames <= 1 and len(track) >= 2:
        dur = float(track[-1].get("t") or 0)
        if dur > 0.2:
            frames = max(2, min(48, int(round(dur * 12))))
    if objects:
        place_objects(objects, face=tuple(cam_loc), fps=12, frames=frames)
        unique = objects
    else:
        plane_list = list(cfg.get("planeImages") or [])
        if cfg.get("planeImage"):
            plane_list = [cfg.get("planeImage")] + plane_list
        seen = set()
        unique = []
        for p in plane_list:
            if p and p not in seen:
                seen.add(p)
                unique.append(p)
        add_layered_planes(unique)
        for p in cfg.get("props") or []:
            import_prop(p)
    add_lights(cfg.get("lights"))
    setup_camera(cfg.get("camera"))

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = min(int(cfg.get("samples") or 32), 12 if frames > 1 else 64)
    scene.render.resolution_x = 1080
    scene.render.resolution_y = 1920
    scene.render.image_settings.file_format = "PNG"
    scene.frame_start = 1
    scene.frame_end = frames
    scene.render.fps = 12
    if os.environ.get("BLENDER_USE_GPU") == "1":
        prefs = bpy.context.preferences.addons.get("cycles")
        if prefs:
            cprefs = prefs.preferences
            cprefs.compute_device_type = "CUDA"
            for d in cprefs.devices:
                d.use = True
        scene.cycles.device = "GPU"

    if frames == 1:
        scene.render.filepath = out_png
        bpy.ops.render.render(write_still=True)
        print("assemble wrote", out_png, "planes", len(unique))
    else:
        base_name = out_png.replace(".png", "")
        frames_dir = base_name + "_frames"
        os.makedirs(frames_dir, exist_ok=True)
        scene.render.filepath = os.path.join(frames_dir, "frame_")
        scene.render.image_settings.file_format = "PNG"
        bpy.ops.render.render(animation=True)
        out_mp4 = base_name + ".mp4"
        import subprocess
        ffmpeg_args = [
            "ffmpeg", "-y", "-framerate", "12",
            "-i", os.path.join(frames_dir, "frame_%04d.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-preset", "fast", "-crf", "23", out_mp4
        ]
        subprocess.run(ffmpeg_args, check=True)
        print("assemble wrote", out_mp4, "from", frames, "frames")


if __name__ == "__main__":
    main()
