"""Blender main-thread boundary for one explicitly paired Team and scene."""

from dataclasses import dataclass
import math
from secrets import token_urlsafe

import bpy
from mathutils import Vector

from . import (
    AgentView, COLORS, agents, assign_agent, extrude_face, face_vertices, move_target, request_redraw, set_view,
    _clear_views, VIEW_SIZE,
)
from .picking import pick_mesh


@dataclass(frozen=True)
class Observation:
    token: str
    revision: int
    location: tuple
    matrix: tuple
    mesh: bpy.types.Mesh
    face_index: int | None
    vertices: tuple | None


class TeamSceneSession:
    def __init__(self, scene, targets):
        targets = tuple(targets)
        if agents or not 1 <= len(targets) <= len(COLORS):
            raise ValueError("Choose between one and ten meshes for an empty Team session")
        if any(
            target.type != "MESH" or target.mode != "OBJECT"
            or scene.objects.get(target.name) != target
            for target in targets
        ) or len(set(targets)) != len(targets):
            raise ValueError("Choose distinct meshes in Object Mode from this scene")
        self.scene = scene
        self.targets = targets
        self.observations: dict[str, Observation] = {}
        self.assigned: dict[str, tuple[int, AgentView]] = {}
        self.closed = False
        self.stopped = set()

    def close(self):
        if not self.closed:
            self.closed = True
            self.observations.clear()
            self.assigned.clear()
            _clear_views()

    def bind(self, worker_id, slot):
        if self.closed or bpy.context.scene != self.scene:
            raise ValueError("The paired Blender scene is no longer active")
        if worker_id in self.stopped:
            raise ValueError("This Blender Worker was stopped")
        if type(slot) is not int or not 0 <= slot < len(self.targets):
            raise ValueError("Slot is outside the paired targets")
        old = self.assigned.get(worker_id)
        if old is not None:
            if old[0] != slot:
                raise ValueError("Worker already owns a different slot")
            return
        if any(assigned_slot == slot for assigned_slot, _ in self.assigned.values()):
            raise ValueError("Slot already belongs to a Worker")
        view = assign_agent(worker_id, self.targets[slot], azimuth=slot * 36, elevation=28, slot=slot)
        self.assigned[worker_id] = (slot, view)

    def release(self, worker_id):
        self.stopped.add(worker_id)
        self.observations.pop(worker_id, None)
        assignment = self.assigned.pop(worker_id, None)
        if assignment is not None:
            view = agents.pop(worker_id, None)
            if view is not None and view.preview is not None:
                view.preview.free()
            request_redraw()

    def _view(self, worker_id):
        if self.closed or bpy.context.scene != self.scene:
            raise ValueError("The paired Blender scene is no longer active")
        assignment = self.assigned.get(worker_id)
        if assignment is None or agents.get(worker_id) is not assignment[1]:
            raise ValueError("Worker has no active Blender assignment")
        view = assignment[1]
        if self.scene.objects.get(view.target.name) != view.target:
            raise ValueError("Assigned target is no longer in this scene")
        return view

    def begin_observation(self, worker_id, azimuth, elevation, face_index=None):
        view = self._view(worker_id)
        vertices = None
        if face_index is not None:
            if type(face_index) is not int or not 0 <= face_index < len(view.target.data.polygons):
                raise ValueError("Face index is outside the assigned mesh")
            vertices = face_vertices(view.target, face_index)
        view.selected = None
        set_view(worker_id, azimuth, elevation)
        observation = Observation(
            token_urlsafe(24), view.revision, tuple(view.target.location),
            tuple(tuple(row) for row in view.target.matrix_world), view.target.data,
            face_index, vertices,
        )
        self.observations[worker_id] = observation
        return observation.token

    def _observation(self, worker_id, token):
        view = self._view(worker_id)
        observation = self.observations.get(worker_id)
        if observation is None or observation.token != token or observation.revision != view.revision:
            raise ValueError("Observation expired or belongs to a different Worker")
        target = view.target
        if (target.mode != "OBJECT" or not target.is_editable
                or tuple(target.location) != observation.location
                or tuple(tuple(row) for row in target.matrix_world) != observation.matrix
                or target.data != observation.mesh):
            raise ValueError("Target changed since observation")
        index = observation.face_index
        if index is not None and (
            index >= len(target.data.polygons) or face_vertices(target, index) != observation.vertices
        ):
            raise ValueError("Face changed since observation")
        return view, observation

    def read_observation(self, worker_id, token):
        view, observation = self._observation(worker_id, token)
        if view.captured_revision != observation.revision or view.png is None:
            return None
        polygons = view.target.data.polygons
        return {
            "observation": token,
            "target": view.target.name,
            "location": observation.location,
            "face_count": len(polygons),
            "faces": [
                {"index": polygon.index, "center": tuple(round(n, 4) for n in polygon.center),
                 "normal": tuple(round(n, 4) for n in polygon.normal)}
                for polygon in polygons[:64]
            ],
            "face_index": observation.face_index,
            "png": view.png,
        }

    def pointer(self, worker_id, token, x, y, kind, action):
        view, observation = self._observation(worker_id, token)
        if view.captured_revision != observation.revision or view.png is None:
            raise ValueError("Wait for the current view before pointing")
        if action not in ("move", "select") or kind not in ("vertex", "face"):
            raise ValueError("Choose pointer move or select and vertex or face mode")
        if view.target.mode != "OBJECT" or any(mod.show_viewport for mod in view.target.modifiers):
            raise ValueError("Cursor editing requires an Object Mode mesh without active modifiers")
        pick, position = pick_mesh(
            self.scene, bpy.context.evaluated_depsgraph_get(), view, x, y, kind, *VIEW_SIZE
        )
        view.point_cursor(position)
        if action == "select":
            view.selected = pick
        return {
            "target": view.target.name,
            "hit": None if pick is None else {"kind": pick.kind, "index": pick.index},
        }

    def edit(self, worker_id, token, operation, value):
        view, observation = self._observation(worker_id, token)
        if view.captured_revision != observation.revision or view.png is None:
            raise ValueError("Wait for the current view before editing")
        if operation in ("move_vertex", "extrude_selected") and any(
            mod.show_viewport for mod in view.target.modifiers
        ):
            raise ValueError("Cursor editing requires a mesh without active modifiers")
        if operation in ("move_vertex", "extrude_selected", "extrude", "create_base") and any(
            child.parent_type in ("VERTEX", "VERTEX_3") for child in view.target.children
        ):
            raise ValueError("Geometry edits require a mesh without vertex-parented children")
        record_undo = bpy.context.preferences.edit.use_global_undo
        if record_undo and not bpy.ops.ed.undo_push.poll():
            raise ValueError("Wait until Blender can record the Team edit in Undo History")
        if operation == "create_base":
            mesh = view.target.data
            if len(mesh.vertices) or mesh.users != 1 or mesh.shape_keys or any(
                mod.show_viewport for mod in view.target.modifiers
            ):
                raise ValueError("Base creation requires an empty, unshared mesh without active modifiers")
            if len(value) != 2 or not all(math.isfinite(n) and 0.1 <= n <= 48 for n in value):
                raise ValueError("Choose a width and depth between 0.1 and 48")
            half_x, half_y = (n / 2 for n in value)
            mesh.from_pydata(
                [(-half_x, -half_y, 0), (half_x, -half_y, 0),
                 (half_x, half_y, 0), (-half_x, half_y, 0)],
                [], [(0, 1, 2, 3)],
            )
            mesh.update()
            bpy.context.view_layer.update()
            view.move_cursor(view.target.matrix_world.translation.copy())
        elif operation == "move":
            move_target(worker_id, value, observation.location)
        elif operation == "extrude" and observation.face_index is not None:
            extrude_face(worker_id, observation.face_index, value, observation.vertices)
        elif operation == "extrude_selected" and view.selected is not None and view.selected.kind == "face":
            selection = view.selected
            extrude_face(worker_id, selection.index, value, selection.coordinates)
        elif operation == "move_vertex" and view.selected is not None and view.selected.kind == "vertex":
            selection = view.selected
            mesh = view.target.data
            delta = Vector(value)
            if len(delta) != 3 or not all(-100 <= component <= 100 for component in delta):
                raise ValueError("Expected three finite offsets of at most 100 units")
            if mesh.users != 1 or mesh.shape_keys or selection.index >= len(mesh.vertices):
                raise ValueError("Choose an unshared mesh without shape keys")
            vertex = mesh.vertices[selection.index]
            if tuple(vertex.co) != selection.coordinates[0]:
                raise ValueError("Vertex changed since selection")
            vertex.co += delta
            position = view.target.matrix_world @ vertex.co
            mesh.update()
            bpy.context.view_layer.update()
            view.move_cursor(position)
        else:
            raise ValueError("Choose a vertex or face with the pointer before editing it")
        self.observations.pop(worker_id)
        if record_undo:
            bpy.ops.ed.undo_push(message="Sprint Coder Team: " + operation)
        return {"target": view.target.name, "revision": view.revision}
