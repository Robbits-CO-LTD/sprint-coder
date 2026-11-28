"""Run in Blender with --factory-startup --python-exit-code 1 --python."""
import json
import socket
import sys
from pathlib import Path

import bmesh
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sprint_coder_team as addon
from sprint_coder_team.session import TeamSceneSession
from sprint_coder_team.bridge import BlenderBridge, Connection


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


def test_parent_move(worker):
    target = addon.agents[worker].target
    child = bpy.data.objects.new("Unpaired child", None)
    bpy.context.scene.collection.objects.link(child)
    child.parent = target
    bpy.context.view_layer.update()
    original = child.matrix_world.copy()
    try:
        addon.move_target(worker, (0, 0, 1), tuple(target.location))
    except ValueError:
        pass
    bpy.context.view_layer.update()
    assert child.matrix_world == original, "Moving the target changed an unpaired child"
    bpy.data.objects.remove(child, do_unlink=True)


def test_closed_edit(session):
    worker = "worker-first"
    token = session.begin_observation(worker, 30, 25)
    view = addon.agents[worker]
    view.captured_revision = view.revision
    view.png = b"fixture only"
    position = tuple(view.target.location)
    bridge = BlenderBridge.__new__(BlenderBridge)
    bridge.session = session
    bridge.session_token = "test-session"
    receiver, sender = socket.socketpair()
    with receiver, sender:
        receiver.setblocking(False)
        sender.sendall(json.dumps({"method": "edit", "token": bridge.session_token,
                                  "worker": worker, "observation": token,
                                  "operation": "move", "value": [1, 0, 0]}).encode() + b"\n")
        sender.shutdown(socket.SHUT_WR)
        bridge._step(Connection(receiver))
    assert tuple(view.target.location) == position, "A disconnected sender changed the mesh"


def test_vertex_pointer(targets):
    session = TeamSceneSession(bpy.context.scene, targets)
    session.bind("vertex-worker", 3)
    token = session.begin_observation("vertex-worker", 0, 70)
    view = addon.agents["vertex-worker"]
    view.captured_revision = view.revision
    view.png = b"fixture only"
    camera, projection = addon.camera_matrices(view, *addon.VIEW_SIZE)
    view.capture_matrix = projection @ camera
    target = targets[3]
    vertex = max(target.data.vertices, key=lambda vert: (vert.co.z, vert.co.x, vert.co.y))
    index = vertex.index
    clip = view.capture_matrix @ (target.matrix_world @ vertex.co).to_4d()
    x = (clip.x / clip.w + 1) / 2
    y = (1 - clip.y / clip.w) / 2
    x, y = x * 0.96 + 0.02, y * 0.96 + 0.02
    before = [tuple(v.co) for v in target.data.vertices]
    pointer = session.pointer("vertex-worker", token, x, y, "vertex", "move")
    assert pointer["hit"] == {"kind": "vertex", "index": index}, pointer
    assert view.selected is None
    try:
        session.edit("vertex-worker", token, "move_vertex", (0, 0, 0.25))
    except ValueError:
        pass
    else:
        raise AssertionError("Hover must not authorize a vertex edit")
    pick = session.pointer("vertex-worker", token, x, y, "vertex", "select")
    assert pick == pointer
    session.edit("vertex-worker", token, "move_vertex", (0, 0, 0.25))
    after = [tuple(v.co) for v in target.data.vertices]
    assert [i for i, (old, new) in enumerate(zip(before, after)) if old != new] == [index], (before, after, index)
    assert abs(after[index][2] - before[index][2] - 0.25) < 0.0001
    session.close()


def test_undo(targets):
    session = TeamSceneSession(bpy.context.scene, targets)
    session.bind("undo-worker", 0)
    target = targets[0]
    name = target.name
    initial_z = target.location.z
    bpy.ops.ed.undo_push(message="Before Team edit")
    token = session.begin_observation("undo-worker", 30, 25)
    view = addon.agents["undo-worker"]
    view.captured_revision = view.revision
    view.png = b"fixture only"
    session.edit("undo-worker", token, "move", (0, 0, 1))
    changed_z = target.location.z
    target.location.z += 1
    bpy.ops.ed.undo_push(message="Human edit")
    session.close()
    bpy.ops.ed.undo()
    assert abs(bpy.data.objects[name].location.z - changed_z) < 0.0001, "Human undo also lost the Team edit"
    bpy.ops.ed.undo()
    assert abs(bpy.data.objects[name].location.z - initial_z) < 0.0001, "Team edit did not undo separately"


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
    test_closed_edit(session)
    test_parent_move("worker-first")
    session.release("worker-first")
    try:
        session.bind("worker-first", 0)
    except ValueError:
        pass
    else:
        raise AssertionError("A late bind restored a released Worker")
    session.bind("replacement", 0)
    session.close()
    test_vertex_pointer(targets)
    test_undo(targets)
    addon.unregister()
    assert not addon.agents
    print("PASS: ten slots, independent matrices, isolated edits, stale edits, Worker-scoped observations and cursor-selected vertex moves")


if __name__ == "__main__":
    test()
