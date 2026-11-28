"""Blender main-thread boundary for one explicitly paired Team and scene."""

from dataclasses import dataclass
from secrets import token_urlsafe

import bpy

from . import (
    AgentView, COLORS, agents, assign_agent, extrude_face, face_vertices, move_target, set_view,
    _clear_views,
)


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

    def close(self):
        if not self.closed:
            self.closed = True
            self.observations.clear()
            self.assigned.clear()
            _clear_views()

    def bind(self, worker_id, slot):
        if self.closed or bpy.context.scene != self.scene:
            raise ValueError("The paired Blender scene is no longer active")
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

    def edit(self, worker_id, token, operation, value):
        view, observation = self._observation(worker_id, token)
        if view.captured_revision != observation.revision or view.png is None:
            raise ValueError("Wait for the current view before editing")
        if operation == "move":
            move_target(worker_id, value, observation.location)
        elif operation == "extrude" and observation.face_index is not None:
            extrude_face(worker_id, observation.face_index, value, observation.vertices)
        else:
            raise ValueError("Choose move or observe the desired face before extrusion")
        self.observations.pop(worker_id)
        return {"target": view.target.name, "revision": view.revision}
