"""Build an editable, self-contained 10-target demo in a factory Blender process."""

from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector


STONE = (0.56, 0.52, 0.44, 1.0)
PLASTER = (0.74, 0.70, 0.60, 1.0)
ROOF = (0.20, 0.26, 0.32, 1.0)
GLASS = (0.13, 0.24, 0.30, 1.0)
STEEL = (0.28, 0.32, 0.32, 1.0)
ROAD = (0.17, 0.20, 0.22, 1.0)
PAVEMENT = (0.45, 0.45, 0.41, 1.0)
PLANTS = (0.27, 0.38, 0.24, 1.0)


def material(name, color):
    result = bpy.data.materials.new(name)
    result.diffuse_color = color
    return result


def box(collection, name, position, size, surface):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.transform(bm, verts=list(bm.verts), matrix=Matrix.Diagonal(Vector((*size, 1))))
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.location = position
    mesh.materials.append(surface)
    return obj


def roof(collection, name, position, width, depth, rise, surface):
    half_width, half_depth = width / 2, depth / 2
    cross = [(-half_width, 0), (half_width, 0), (0, rise)]
    coords = [(x, y, z) for y in (-half_depth, half_depth) for x, z in cross]
    faces = [(0, 1, 2), (5, 4, 3), (3, 4, 1, 0), (4, 5, 2, 1), (5, 3, 0, 2)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(coords, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.location = position
    mesh.materials.append(surface)
    return obj


def collection(scene, name):
    result = bpy.data.collections.new(name)
    scene.collection.children.link(result)
    return result


def build(scene):
    context = collection(scene, "街区 • Context")
    targets = collection(scene, "Team targets • 10")
    stone = material("Stone", STONE)
    roofs = material("Slate roof", ROOF)
    glass = material("Glass", GLASS)
    steel = material("Dark metal", STEEL)
    asphalt = material("Asphalt", ROAD)
    pavement = material("Sidewalk", PAVEMENT)
    plants = material("Planting", PLANTS)
    line = material("Street marking", (0.68, 0.66, 0.54, 1.0))
    shell_colors = [PLASTER, (0.53, 0.65, 0.61, 1), (0.65, 0.59, 0.51, 1),
                    (0.67, 0.67, 0.61, 1), (0.63, 0.52, 0.45, 1)]
    facades = [material(f"Facade {i + 1}", color) for i, color in enumerate(shell_colors)]

    box(context, "City block plinth", (0, 0, -0.42), (35, 21, 0.64), asphalt)
    for side in (-1, 1):
        box(context, f"Raised sidewalk {side}", (0, side * 6.25, -0.02), (35, 8.4, 0.22), pavement)
    for i in range(-15, 16, 3):
        box(context, f"Lane marking {i}", (i, 0, -0.09), (1.4, 0.11, 0.012), line)
    for i in range(8):
        box(context, f"Zebra stripe {i}", (-14.1, (i - 3.5) * 0.55, -0.086), (1.8, 0.3, 0.012), line)

    parts = []
    for i, feature in enumerate(
        ("Gable roof", "Awning", "Roof plant", "Parapet", "Clerestory",
         "Roof stair enclosure", "Skylight", "Roof terrace", "Roof dormer", "Canopy")
    ):
        col, row = i % 5, i // 5
        x, y = (col - 2) * 5.8, (-1 if row == 0 else 1) * 5.7
        direct = 1 if y < 0 else -1
        width = 4.0 + (i % 3) * 0.25
        depth = 3.7 + (i % 4) * 0.18
        height = 3.9 + (i * 7 % 5) * 0.55
        face_y = y + direct * (depth / 2 + 0.025)
        box(context, f"Building {i + 1:02}", (x, y, 0.09 + height / 2),
            (width, depth, height), facades[i % len(facades)])
        box(context, f"Foundation {i + 1:02}", (x, y, 0.22), (width + 0.14, depth + 0.12, 0.26), stone)
        for floor in range(1, int(height // 1.45) + 1):
            for pane in (-1, 0, 1):
                box(context, f"Window {i + 1:02}.{floor}.{pane + 2}",
                    (x + pane * width * 0.27, face_y, floor * 1.38 + 0.38),
                    (0.68, 0.08, 0.78), glass)
        box(context, f"Entry {i + 1:02}", (x, face_y, 1.05), (0.82, 0.13, 1.95), steel)
        box(context, f"Planter {i + 1:02}", (x + 1.35, face_y + direct * 0.65, 0.29),
            (0.8, 0.56, 0.39), plants)
        label = f"{i + 1:02} • {feature}"
        if i in (0, 4, 8):
            parts.append(roof(targets, label, (x, y, height + 0.09),
                              width + 0.34, depth + 0.24, 0.77, roofs))
        elif i in (1, 9):
            parts.append(box(targets, label, (x, face_y + direct * 0.38, 2.25),
                             (width * 0.82, 1.03, 0.18), roofs))
        else:
            z = 0.28 + (i % 3) * 0.17
            parts.append(box(targets, label, (x, y, height + 0.09 + z / 2),
                             (width * 0.69, depth * 0.6, z), roofs if i != 6 else glass))
    return parts


def main():
    scene = bpy.context.scene
    scene.name = "Sprint Coder • City Block"
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    targets = build(scene)
    for target in targets:
        assert target.type == "MESH" and target.data.users == 1 and target.is_editable
        target.select_set(True)
    bpy.context.view_layer.objects.active = targets[0]
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                view = area.spaces.active
                view.shading.color_type = "MATERIAL"
                view.shading.show_shadows = True
                view.shading.show_cavity = True
                view.overlay.show_floor = False
                view.overlay.show_axis_x = False
                view.overlay.show_axis_y = False
                view.region_3d.view_perspective = "ORTHO"
                view.region_3d.view_location = (1.3, 0.0, 0.9)
                view.region_3d.view_distance = 42
                view.region_3d.view_rotation = Euler((0.88, 0.0, -0.40)).to_quaternion()
    bpy.ops.wm.save_as_mainfile(filepath=str(Path(sys.argv[-1]).resolve()))


if __name__ == "__main__":
    main()
