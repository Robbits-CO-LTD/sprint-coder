"""Resolve a Worker's image-space pointer against its visible mesh."""

from dataclasses import dataclass
import math

from mathutils import Vector


@dataclass(frozen=True)
class MeshPick:
    kind: str
    index: int
    coordinates: tuple


def _unproject(inverse, x, y, depth):
    point = inverse @ Vector((x * 2 - 1, 1 - y * 2, depth, 1))
    return point.to_3d() / point.w


def pick_mesh(scene, depsgraph, view, x, y, kind, width, height):
    matrix = view.capture_matrix
    if matrix is None or not all(math.isfinite(n) and 0 <= n <= 1 for n in (x, y)):
        raise ValueError("Use coordinates between zero and one from the current view")
    inverse = matrix.inverted()
    near = _unproject(inverse, x, y, -1)
    far = _unproject(inverse, x, y, 1)
    direction = far - near
    hit, point, _, index, obj, _ = scene.ray_cast(
        depsgraph, near, direction.normalized(), distance=direction.length
    )
    target = view.target
    if not hit or obj.original != target or not 0 <= index < len(target.data.polygons):
        return None, point if hit else near + direction.normalized() * (target.dimensions.length / 2)

    polygon = target.data.polygons[index]
    if kind == "face":
        return MeshPick(kind, index, tuple(tuple(target.data.vertices[i].co)
                                           for i in polygon.vertices)), point
    if kind != "vertex":
        raise ValueError("Choose vertex or face selection")

    candidates = []
    for vi in polygon.vertices:
        vertex = target.data.vertices[vi].co
        world = target.matrix_world @ vertex
        clip = matrix @ world.to_4d()
        if clip.w <= 0:
            continue
        projected_x = (clip.x / clip.w + 1) / 2
        projected_y = (1 - clip.y / clip.w) / 2
        pixel_distance = math.hypot((projected_x - x) * width, (projected_y - y) * height)
        if pixel_distance <= 18:
            origin = _unproject(inverse, projected_x, projected_y, -1)
            sight = world - origin
            epsilon = max(0.0001, target.dimensions.length * 0.0001)
            if sight.length > epsilon and scene.ray_cast(
                depsgraph, origin, sight.normalized(), distance=sight.length - epsilon
            )[0]:
                continue
            candidates.append((pixel_distance, vi, vertex, world))
    if not candidates:
        return None, point
    _, index, vertex, world = min(candidates, key=lambda entry: (entry[0], entry[1]))
    return MeshPick(kind, index, (tuple(vertex),)), world
