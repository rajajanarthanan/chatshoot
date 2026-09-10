"""Showroom plate — vertical still for Remotion kit backdrop.

Two emissive video planes + hero pedestal + camera dolly frame mid-path.
Runs headless via: blender -b -P showroom.py -- /path/out.png
"""
import bpy
import sys
import math

out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "/tmp/showroom.png"

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 1080
scene.render.resolution_y = 1920
scene.render.filepath = out
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False

# Prefer GPU if BLENDER_USE_GPU=1 and devices exist
import os

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


def mat(name, color, emission=0.0, metallic=0.0, roughness=0.45):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = metallic
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = roughness
        # Blender 4+/5 emission on Principled
        if emission > 0 and "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
            if "Emission Strength" in bsdf.inputs:
                bsdf.inputs["Emission Strength"].default_value = emission
    return m


# World — dark teal showroom
world = bpy.data.worlds.new("ShowroomWorld")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs[0].default_value = (0.02, 0.04, 0.06, 1.0)
    bg.inputs[1].default_value = 0.4

floor_mat = mat("Floor", (0.08, 0.09, 0.11), metallic=0.7, roughness=0.25)
plane_a_mat = mat("ScreenA", (0.15, 0.85, 0.75), emission=4.0, roughness=0.2)
plane_b_mat = mat("ScreenB", (0.35, 0.55, 1.0), emission=3.5, roughness=0.2)
hero_mat = mat("Hero", (0.85, 0.88, 0.92), metallic=0.85, roughness=0.2)
pedestal_mat = mat("Pedestal", (0.12, 0.13, 0.15), metallic=0.4, roughness=0.35)

# Floor
bpy.ops.mesh.primitive_plane_add(size=24, location=(0, 0, 0))
floor = bpy.context.object
floor.data.materials.append(floor_mat)

# Back wall
bpy.ops.mesh.primitive_plane_add(size=16, location=(0, 6, 4))
wall = bpy.context.object
wall.rotation_euler = (math.radians(90), 0, 0)
wall.data.materials.append(mat("Wall", (0.05, 0.06, 0.08), roughness=0.9))

# Video plane A (left screen)
bpy.ops.mesh.primitive_plane_add(size=2.4, location=(-3.2, 1.5, 2.0))
pa = bpy.context.object
pa.rotation_euler = (math.radians(90), 0, math.radians(18))
pa.data.materials.append(plane_a_mat)

# Video plane B (right screen)
bpy.ops.mesh.primitive_plane_add(size=2.4, location=(3.2, 1.5, 2.0))
pb = bpy.context.object
pb.rotation_euler = (math.radians(90), 0, math.radians(-18))
pb.data.materials.append(plane_b_mat)

# Pedestal + hero product block
bpy.ops.mesh.primitive_cylinder_add(radius=0.7, depth=0.35, location=(0, 0.5, 0.18))
ped = bpy.context.object
ped.data.materials.append(pedestal_mat)

bpy.ops.mesh.primitive_cube_add(size=0.9, location=(0, 0.5, 0.85))
hero = bpy.context.object
hero.scale = (0.7, 0.35, 1.1)
hero.data.materials.append(hero_mat)

# Camera — mid drone path
cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 35
cam = bpy.data.objects.new("Cam", cam_data)
bpy.context.collection.objects.link(cam)
scene.camera = cam
cam.location = (0, -8, 3.2)
cam.rotation_euler = (math.radians(72), 0, 0)
cam.keyframe_insert(data_path="location", frame=1)
cam.location = (0.4, -3.5, 2.4)
cam.keyframe_insert(data_path="location", frame=24)
scene.frame_set(12)

# Lights
key = bpy.data.lights.new(name="Key", type="AREA")
key.energy = 280
key.size = 4
key_o = bpy.data.objects.new(name="Key", object_data=key)
bpy.context.collection.objects.link(key_o)
key_o.location = (5, -4, 6)

rim = bpy.data.lights.new(name="Rim", type="AREA")
rim.energy = 120
rim.size = 3
rim_o = bpy.data.objects.new(name="Rim", object_data=rim)
bpy.context.collection.objects.link(rim_o)
rim_o.location = (-4, 3, 5)

bpy.ops.render.render(write_still=True)
print("rendered", out)
