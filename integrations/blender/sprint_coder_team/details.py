"""Build detail geometry on a face selected by a Team cursor."""

import bmesh
import bpy
from mathutils import Vector

DETAILS = ("gable_roof", "hip_roof", "window_bank", "entrance", "street_detail")
UP = Vector((0, 0, 1))


def _surface(mesh, name, color):
    name = "Team Detail • " + name
    slot = mesh.materials.find(name)
    if slot >= 0:
        return slot
    material = bpy.data.materials.get(name)
    if material is None:
        material = bpy.data.materials.new(name)
        material.diffuse_color = color
    mesh.materials.append(material)
    return len(mesh.materials) - 1


def _element(bm, positions, polygons, material):
    vertices = [bm.verts.new(point) for point in positions]
    for polygon in polygons:
        face = bm.faces.new([vertices[index] for index in polygon])
        face.material_index = material


def _box(bm, center, across, up, normal, width, height, depth, material):
    positions = [center + across * (x * width / 2) + up * (y * height / 2) + normal * z * depth
                 for z in (0, 1) for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    polygons = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4),
                (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    _element(bm, positions, polygons, material)


def _roof(bm, mesh, points, kind):
    left, right = min(p.x for p in points) - .16, max(p.x for p in points) + .16
    near, far = min(p.y for p in points) - .16, max(p.y for p in points) + .16
    z = max(p.z for p in points)
    ridge = (left + right) / 2
    inset = .38 if kind == "hip_roof" else 0
    height = min(1.15, (right - left) * .24)
    positions = [(left, near, z), (right, near, z), (right, far, z), (left, far, z),
                 (ridge, near + inset, z + height), (ridge, far - inset, z + height)]
    material = _surface(mesh, "Roof slate" if kind == "hip_roof" else "Roof tile",
                        (.19, .25, .31, 1) if kind == "hip_roof" else (.37, .19, .15, 1))
    _element(bm, positions, [(3, 2, 1, 0), (0, 1, 4), (2, 3, 5), (1, 2, 5, 4), (3, 0, 4, 5)],
             material)
    _box(bm, Vector((ridge, (near + far) / 2, z + .045)), Vector((1, 0, 0)),
         Vector((0, 1, 0)), -UP, right - left, far - near, .11,
         _surface(mesh, "Roof trim", (.72, .68, .60, 1)))


def _facade(bm, mesh, points, normal, kind):
    horizontal = UP.cross(normal).normalized()
    low, high = min(horizontal.dot(p) for p in points), max(horizontal.dot(p) for p in points)
    bottom, top = min(p.z for p in points), max(p.z for p in points)
    width, height = high - low, top - bottom
    distance = normal.dot(points[0])
    if min(width, height) < 1:
        raise ValueError("Choose a building wall at least one unit wide and tall")
    frame = _surface(mesh, "Window frames", (.12, .14, .15, 1))
    glass = _surface(mesh, "Blue glazing", (.30, .52, .65, 1))

    def at(u, v):
        return horizontal * (low + width * u) + UP * (bottom + height * v) + normal * distance

    if kind == "window_bank":
        rows = (.46, .76) if height >= 3.4 else (.66,)
        for row in rows:
            for column in (.22, .5, .78):
                center = at(column, row)
                w, h = width * .17, height * .19
                _box(bm, center, horizontal, UP, normal, w, h, .07, frame)
                _box(bm, center + normal * .069, horizontal, UP, normal, w * .79, h * .76,
                     .015, glass)
        return
    door = _surface(mesh, "Entry oak", (.42, .23, .13, 1))
    _box(bm, at(.5, .17), horizontal, UP, normal, width * .3, height * .32, .11, frame)
    _box(bm, at(.5, .17) + normal * .11, horizontal, UP, normal, width * .23,
         height * .28, .025, door)
    _box(bm, at(.5, .36), horizontal, UP, normal, width * .53, .13, .52,
         _surface(mesh, "Canopies", (.58, .25, .20, 1)))


def _street(bm, mesh, points):
    left, right = min(p.x for p in points), max(p.x for p in points)
    near, far = min(p.y for p in points), max(p.y for p in points)
    z = max(p.z for p in points)
    center = (left + right) / 2
    walk = _surface(mesh, "Sidewalk", (.53, .52, .47, 1))
    mark = _surface(mesh, "Road markings", (.78, .75, .63, 1))
    x_axis, y_axis = Vector((1, 0, 0)), Vector((0, 1, 0))
    for edge, direction in ((near, -1), (far, 1)):
        _box(bm, Vector((center, edge + direction * .37, z)), x_axis, y_axis, UP,
             right - left, .72, .12, walk)
        for fraction in (.22, .41, .59, .78):
            x = left + fraction * (right - left)
            _box(bm, Vector((x, edge + direction * 2.4, 0)), x_axis, y_axis, UP,
                 .7, 4.0, .09, walk)
    for i in range(9):
        x = left + (i + .5) * (right - left) / 9
        _box(bm, Vector((x, (near + far) / 2, z)), x_axis, y_axis, UP,
             (right - left) / 18, .075, .02, mark)


def add_face_detail(view, selection, kind):
    target = view.target
    mesh = target.data
    if kind not in DETAILS:
        raise ValueError("Unknown face detail")
    if mesh.users != 1 or mesh.shape_keys or selection.index >= len(mesh.polygons):
        raise ValueError("Choose an unshared mesh without shape keys")
    face = mesh.polygons[selection.index]
    points = [mesh.vertices[index].co.copy() for index in face.vertices]
    if tuple(tuple(point) for point in points) != selection.coordinates:
        raise ValueError("Face changed since selection")
    normal = face.normal.copy()
    if kind in ("window_bank", "entrance"):
        if abs(normal.z) > .10:
            raise ValueError("Choose a vertical wall for a window bank or entrance")
    elif normal.z < .95:
        raise ValueError("Choose a visible top face for a roof or street detail")
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        if kind in ("gable_roof", "hip_roof"):
            _roof(bm, mesh, points, kind)
        elif kind == "street_detail":
            _street(bm, mesh, points)
        else:
            _facade(bm, mesh, points, normal, kind)
        bm.normal_update()
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.update()
    bpy.context.view_layer.update()
    view.move_cursor(target.matrix_world @ (sum(points, Vector()) / len(points)))
