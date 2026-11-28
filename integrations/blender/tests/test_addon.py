"""Run in Blender with --factory-startup --python-exit-code 1 --python."""
import sys
from pathlib import Path

import bmesh
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sprint_coder_team as addon
from sprint_coder_team.session import TeamSceneSession


def setup():
    addon.register()
    for i in range(10):
        mesh = bpy.data.meshes.new(f"Team demo mesh {i + 1:02}")
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.1)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(f"Team demo {i + 1:02}", mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = ((i % 5 - 2) * 2.3, (i // 5 - 0.5) * 3, 0.45)
        bpy.context.view_layer.update()
        addon.assign_agent(f"worker-{i}", obj, i * 36, 15 + i * 5)
    return addon.agents


def test():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    agents = setup()
    assert [v.label for v in agents.values()] == [f"AI-{i:02}" for i in range(1, 11)]
    assert len({tuple(v.color) for v in agents.values()}) == 10
    first = agents["worker-0"]
    last = agents["worker-9"]
    first_camera, _ = addon.camera_matrices(first, *addon.VIEW_SIZE)
    last_camera, _ = addon.camera_matrices(last, *addon.VIEW_SIZE)
    assert first_camera != last_camera
    original = tuple(first.target.location)
    second_original = tuple(last.target.location)
    addon.move_target("worker-0", (0, 0, 1), original)
    addon.move_target("worker-9", (0, 0, 2), second_original)
    assert abs(first.position.z - (original[2] + 1)) < 0.0001
    assert abs(last.position.z - (second_original[2] + 2)) < 0.0001
    assert first.cursor_position(first.moved_at) == first.previous_position
    assert first.cursor_position(first.moved_at + 1) == first.position
    try:
        addon.move_target("worker-0", (0, 0, 1), original)
    except ValueError as error:
        assert str(error) == "Target changed since observation"
    else:
        raise AssertionError("An old observation must not permit a second edit")
    face_index = max(first.target.data.polygons, key=lambda p: p.normal.z).index
    vertices = addon.face_vertices(first.target, face_index)
    face_count = len(first.target.data.polygons)
    assert addon.extrude_face("worker-0", face_index, 0.4, vertices) == 2
    assert len(first.target.data.polygons) == face_count + 4
    assert len(last.target.data.polygons) == face_count
    try:
        addon.extrude_face("worker-0", face_index, 0.4, vertices)
    except ValueError:
        pass
    else:
        raise AssertionError("An old face snapshot must not permit a second extrusion")
    targets = [view.target for view in agents.values()]
    addon._clear_views()
    session = TeamSceneSession(bpy.context.scene, targets)
    session.bind("worker-last", 9)
    session.bind("worker-first", 0)
    assert addon.agents["worker-last"].label == "AI-10"
    assert addon.agents["worker-first"].label == "AI-01"
    token = session.begin_observation("worker-first", 30, 25)
    assert session.read_observation("worker-first", token) is None
    view = addon.agents["worker-first"]
    view.captured_revision = view.revision
    view.png = b"fixture only"
    assert session.read_observation("worker-first", token)["target"] == targets[0].name
    for worker in ("unknown", "worker-last"):
        try:
            session.edit(worker, token, "move", (1, 0, 0))
        except ValueError:
            pass
        else:
            raise AssertionError("Observation escaped its Worker")
    assert session.edit("worker-first", token, "move", (1, 0, 0))["target"] == targets[0].name
    try:
        session.edit("worker-first", token, "move", (1, 0, 0))
    except ValueError:
        pass
    else:
        raise AssertionError("Observation token was accepted twice")
    session.close()
    addon.unregister()
    assert not addon.agents
    print("PASS: ten slots, independent matrices, isolated edits, stale edits, Worker-scoped observations")


if __name__ == "__main__":
    test()
