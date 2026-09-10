"""Cafe plate — warm vertical still for Remotion kit backdrop."""
import bpy
import sys
import math
import os

out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "/tmp/cafe.png"

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 20
scene.cycles.use_denoising = True
scene.render.resolution_x = 1080
scene.render.resolution_y = 1920
scene.render.filepath = out
scene.render.image_settings.file_format = "PNG"

if os.environ.get("BLENDER_USE_GPU") == "1":
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "CUDA"
        for d in prefs.get_devices_for_type("CUDA"):
            d.use = True
        scene.cycles.device = "GPU"
    except Exception:
        scene.cycles.device = "CPU"
else:
    scene.cycles.device = "CPU"


def mat(name, color, emission=0.0, metallic=0.0, roughness=0.5):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = metallic
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = roughness
        if emission > 0 and "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
            if "Emission Strength" in bsdf.inputs:
                bsdf.inputs["Emission Strength"].default_value = emission
    return m


world = bpy.data.worlds.new("CafeWorld")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs[0].default_value = (0.12, 0.08, 0.05, 1.0)
    bg.inputs[1].default_value = 0.35

# Floor + table + cups + warm pendant glow
bpy.ops.mesh.primitive_plane_add(size=14, location=(0, 0, 0))
bpy.context.object.data.materials.append(mat("Floor", (0.18, 0.12, 0.08), roughness=0.7))

bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0.2, 0.55))
tbl = bpy.context.object
tbl.scale = (1.6, 1.0, 0.08)
tbl.data.materials.append(mat("Table", (0.25, 0.14, 0.08), roughness=0.4))

bpy.ops.mesh.primitive_cylinder_add(radius=0.12, depth=0.2, location=(-0.35, 0.1, 0.75))
bpy.context.object.data.materials.append(mat("CupA", (0.9, 0.9, 0.88), roughness=0.3))
bpy.ops.mesh.primitive_cylinder_add(radius=0.12, depth=0.2, location=(0.4, 0.15, 0.75))
bpy.context.object.data.materials.append(mat("CupB", (0.85, 0.75, 0.65), roughness=0.3))

# Menu board (emissive)
bpy.ops.mesh.primitive_plane_add(size=1.8, location=(0, 2.2, 2.2))
board = bpy.context.object
board.rotation_euler = (math.radians(90), 0, 0)
board.data.materials.append(mat("Menu", (1.0, 0.75, 0.35), emission=2.5, roughness=0.35))

cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 40
cam = bpy.data.objects.new("Cam", cam_data)
bpy.context.collection.objects.link(cam)
scene.camera = cam
cam.location = (0, -5.5, 2.2)
cam.rotation_euler = (math.radians(68), 0, 0)

warm = bpy.data.lights.new(name="Warm", type="POINT")
warm.energy = 400
warm.color = (1.0, 0.75, 0.45)
w = bpy.data.objects.new(name="Warm", object_data=warm)
bpy.context.collection.objects.link(w)
w.location = (0.5, -1.5, 2.8)

bpy.ops.render.render(write_still=True)
print("rendered", out)
