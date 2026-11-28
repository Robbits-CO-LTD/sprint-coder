"""Open a disposable GPU viewport for the Blender bridge integration test."""

from pathlib import Path
import sys

import bpy
from mathutils import Euler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_addon import addon, setup
from sprint_coder_team.bridge import BlenderBridge


def start():
    for obj in list(bpy.context.scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    targets = [view.target for view in setup().values()]
    addon._clear_views()
    bridge = BlenderBridge(bpy.context.scene, targets)
    for area in bpy.context.window.screen.areas:
        if area.type == "VIEW_3D":
            view = area.spaces.active.region_3d
            view.view_distance = 16
            view.view_rotation = Euler((0.95, 0.0, 0.1)).to_quaternion()
    bpy.app.timers.register(bridge.tick)
    # This file is in the test process’s private temporary directory. Never log the pairing code.
    Path(sys.argv[-1]).write_text(bridge.pairing_code, encoding="ascii")


bpy.app.timers.register(start, first_interval=0.1)
