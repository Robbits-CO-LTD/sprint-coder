"""Record an empty-to-edited city in an isolated real Blender viewport."""

import json
from pathlib import Path
import sys

import bpy
from mathutils import Euler

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sprint_coder_team as addon
from sprint_coder_team.bridge import BlenderBridge

directory = Path(sys.argv[-1]).resolve().parent
if (
    "--" not in sys.argv
    or bpy.data.filepath
    or not Path(bpy.utils.user_resource("CONFIG")).resolve().is_relative_to(directory.parent)
    or (directory / "capture-00000.png").exists()
):
    raise RuntimeError("Recording requires a fresh, isolated Blender profile and output directory")
bridge = None
targets = []
frame = 0
colors = [(0.73, 0.56, 0.37, 1), (0.32, 0.55, 0.60, 1), (0.46, 0.56, 0.34, 1),
          (0.64, 0.39, 0.33, 1), (0.55, 0.48, 0.65, 1)]


def setup():
    global bridge
    bpy.context.preferences.filepaths.temporary_directory = str(directory)
    scene = bpy.context.scene
    scene.name = "Sprint Coder Team • New street"
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    block = bpy.data.collections.new("Ten Worker sites")
    scene.collection.children.link(block)
    for i in range(10):
        x, y = ((i % 5 - 2) * 5.2, -4.0 if i < 5 else 4.0)
        label = f"{i+1:02} Building"
        color = colors[i % len(colors)]
        if i == 9:
            label, x, y, color = "10 Street", 0, 0, (0.22, 0.23, 0.27, 1)
        mesh = bpy.data.meshes.new(label)
        obj = bpy.data.objects.new(label, mesh)
        block.objects.link(obj)
        obj.location = (x, y, 0)
        obj.color = color
        material = bpy.data.materials.new(label)
        material.diffuse_color = color
        mesh.materials.append(material)
        targets.append(obj)
    bpy.context.view_layer.update()
    for area in bpy.context.window.screen.areas:
        if area.type == "VIEW_3D":
            space = area.spaces.active
            space.shading.color_type = "MATERIAL"
            space.shading.show_cavity = True
            space.overlay.show_floor = True
            view = space.region_3d
            view.view_perspective = "ORTHO"
            view.view_location = (1.0, 0.0, 1.5)
            view.view_distance = 36
            view.view_rotation = Euler((0.87, 0.0, -0.32)).to_quaternion()
    addon.register()
    bridge = BlenderBridge(scene, targets)
    bpy.app.timers.register(bridge.tick)
    bpy.app.timers.register(record, first_interval=0.5)


def record():
    global frame
    window = bpy.context.window_manager.windows[0]
    area = next(a for a in window.screen.areas if a.type == "VIEW_3D")
    path = directory / f"capture-{frame:05}.png"
    with bpy.context.temp_override(window=window, area=area):
        assert bpy.ops.screen.screenshot(filepath=str(path)) == {"FINISHED"}
    frame += 1
    if frame == 2:
        Path(sys.argv[-1]).write_text(bridge.pairing_code, encoding="ascii")
    if (directory / "finish-request").exists():
        witness = [
            {"name": obj.name, "faces": len(obj.data.polygons),
             "vertices": len(obj.data.vertices), "height": obj.dimensions.z}
            for obj in targets
        ]
        bpy.ops.wm.save_as_mainfile(filepath=str(directory / "worker-built-street.blend"))
        (directory / "finish-result.json").write_text(json.dumps(witness), encoding="utf8")
        return None
    return 0.36


bpy.app.timers.register(setup, first_interval=0.3)
