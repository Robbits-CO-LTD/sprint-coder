import math
import struct
import time
import zlib
from dataclasses import dataclass

import blf
import bmesh
import bpy
import gpu
from bpy.app.handlers import persistent
from bpy_extras.view3d_utils import location_3d_to_region_2d
from gpu_extras.batch import batch_for_shader
from gpu_extras.presets import draw_texture_2d
from mathutils import Matrix, Vector

COLORS = (
    (1.0, 0.31, 0.32, 1.0),
    (1.0, 0.55, 0.19, 1.0),
    (1.0, 0.80, 0.27, 1.0),
    (0.78, 0.92, 0.29, 1.0),
    (0.35, 0.92, 0.40, 1.0),
    (0.24, 0.89, 0.69, 1.0),
    (0.28, 0.83, 0.98, 1.0),
    (0.38, 0.58, 1.0, 1.0),
    (0.71, 0.48, 1.0, 1.0),
    (1.0, 0.46, 0.73, 1.0),
)
VIEW_SIZE = (256, 144)
PREVIEW_SIZE = (120, 67)


@dataclass
class AgentView:
    slot: int
    target: bpy.types.Object
    position: Vector
    azimuth: float
    elevation: float
    revision: int = 0
    captured_revision: int = -1
    preview: gpu.types.GPUOffScreen | None = None
    png: bytes | None = None
    previous_position: Vector | None = None
    moved_at: float = 0.0

    def move_cursor(self, position):
        now = time.monotonic()
        self.previous_position = self.cursor_position(now)
        self.position = position
        self.moved_at = now
        self.revision += 1
        _schedule_redraw()

    def cursor_position(self, now):
        if self.previous_position is None:
            return self.position
        fraction = min(1.0, (now - self.moved_at) / 0.18)
        return self.previous_position.lerp(self.position, fraction)

    @property
    def color(self):
        return COLORS[self.slot]

    @property
    def label(self):
        return f"AI-{self.slot + 1:02}"


agents: dict[str, AgentView] = {}
_handlers = []
_capturing = False
_preview_offset = 0


def request_redraw():
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


def _schedule_redraw():
    if not bpy.app.timers.is_registered(request_redraw):
        bpy.app.timers.register(request_redraw, first_interval=0.01)


def assign_agent(agent_id, target, azimuth=45, elevation=25, slot=None):
    if not _is_live(target, bpy.context.scene) or target.type != "MESH" or target.mode != "OBJECT":
        raise ValueError("Choose a mesh in Object Mode")
    if agent_id in agents or any(view.target == target for view in agents.values()):
        raise ValueError("Agent or target is already assigned")
    if len(agents) >= len(COLORS):
        raise ValueError("All ten cursor slots are assigned")
    available = [index for index in range(len(COLORS))
                 if all(view.slot != index for view in agents.values())]
    if slot is None:
        slot = available[0]
    elif slot not in available:
        raise ValueError("Cursor slot is already occupied")
    view = AgentView(slot, target, target.matrix_world.translation.copy(), azimuth, elevation)
    agents[agent_id] = view
    request_redraw()
    return view


def set_view(agent_id, azimuth, elevation):
    if not math.isfinite(azimuth) or not math.isfinite(elevation) or abs(elevation) > 89:
        raise ValueError("Use finite angles and an elevation between -89 and 89 degrees")
    view = _assigned_view(agent_id)
    view.azimuth, view.elevation = azimuth % 360, elevation
    view.revision += 1
    request_redraw()


def _assigned_view(agent_id):
    view = agents[agent_id]
    if not _is_live(view.target, bpy.context.scene):
        raise ValueError("Target is no longer in this scene")
    return view


def move_target(agent_id, displacement, expected_location):
    view = _assigned_view(agent_id)
    target = view.target
    if target.mode != "OBJECT" or tuple(target.location) != tuple(expected_location):
        raise ValueError("Target changed since observation")
    delta = Vector(displacement)
    if len(delta) != 3 or not all(math.isfinite(value) and abs(value) <= 100 for value in delta):
        raise ValueError("Expected three finite offsets of at most 100 units")
    if target.parent:
        raise ValueError("This operation requires an unparented target")
    target.location += delta
    bpy.context.view_layer.update()
    view.move_cursor(target.matrix_world.translation.copy())
    return tuple(target.location)


def face_vertices(target, face_index):
    polygon = target.data.polygons[face_index]
    return tuple(tuple(target.data.vertices[index].co) for index in polygon.vertices)


def extrude_face(agent_id, face_index, distance, expected_vertices):
    view = _assigned_view(agent_id)
    target = view.target
    mesh = target.data
    if target.mode != "OBJECT" or mesh.users != 1 or mesh.shape_keys:
        raise ValueError("Choose an unshared mesh without shape keys in Object Mode")
    if not math.isfinite(distance) or distance == 0 or abs(distance) > 100:
        raise ValueError("Extrusion distance must be nonzero and at most 100 units")
    if not 0 <= face_index < len(mesh.polygons):
        raise ValueError("Face index is outside the target mesh")
    if face_vertices(target, face_index) != tuple(map(tuple, expected_vertices)):
        raise ValueError("Face changed since observation")
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        bm.faces.ensure_lookup_table()
        face = bm.faces[face_index]
        offset = face.normal * distance
        cap, = bmesh.ops.extrude_discrete_faces(bm, faces=[face])["faces"]
        bmesh.ops.translate(bm, vec=offset, verts=list(cap.verts))
        bm.normal_update()
        center = cap.calc_center_median()
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.update()
    bpy.context.view_layer.update()
    view.move_cursor(target.matrix_world @ center)
    return view.revision


def _png(width, height, rgba):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    stride = width * 4
    rows = b"".join(b"\x00" + rgba[y * stride:(y + 1) * stride]
                    for y in range(height - 1, -1, -1))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 1))
            + chunk(b"IEND", b""))


def camera_matrices(view, width, height):
    target = view.target
    center = sum((target.matrix_world @ Vector(corner) for corner in target.bound_box),
                 Vector((0, 0, 0))) / 8
    radius = max(target.dimensions.length / 2, 0.25)
    azimuth, elevation = math.radians(view.azimuth), math.radians(view.elevation)
    offset = Vector((math.cos(elevation) * math.cos(azimuth),
                     math.cos(elevation) * math.sin(azimuth), math.sin(elevation)))
    pose = (-offset).to_track_quat("-Z", "Y").to_matrix().to_4x4()
    pose.translation = center + offset * (radius * 3.2)
    near, far = radius * 0.01, radius * 20
    right = near * math.tan(math.radians(23))
    top = right * height / width
    projection = Matrix(((near / right, 0, 0, 0), (0, near / top, 0, 0),
                         (0, 0, -(far + near) / (far - near), -2 * far * near / (far - near)),
                         (0, 0, -1, 0)))
    return pose.inverted(), projection


def _live_views(context):
    return [view for view in agents.values()
            if _is_live(view.target, context.scene)]


def _is_live(target, scene):
    try:
        return scene.objects.get(target.name) == target
    except ReferenceError:
        return False


def _capture(context, view):
    global _capturing
    _capturing = True
    try:
        if view.preview is None:
            view.preview = gpu.types.GPUOffScreen(*VIEW_SIZE)
        view_matrix, projection = camera_matrices(view, *VIEW_SIZE)
        view.preview.draw_view3d(
            context.scene, context.view_layer, context.space_data, context.region,
            view_matrix, projection, do_color_management=True,
        )
        width, height = VIEW_SIZE
        with view.preview.bind():
            pixels = gpu.state.active_framebuffer_get().read_color(
                0, 0, width, height, 4, 0, "UBYTE"
            )
            pixels.dimensions = width * height * 4
            view.png = _png(width, height, bytes(pixels))
        view.captured_revision = view.revision
    finally:
        _capturing = False


def _line(shader, vertices, color):
    shader.bind()
    shader.uniform_float("color", color)
    batch_for_shader(shader, "LINES", {"pos": vertices}).draw(shader)


def _draw_cursors():
    if _capturing:
        return
    shader = gpu.shader.from_builtin("UNIFORM_COLOR")
    axes = (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
    now = time.monotonic()
    for view in _live_views(bpy.context):
        position = view.cursor_position(now)
        size = max(0.12, min(view.target.dimensions.length * 0.08, 0.5))
        vertices = [position + axis * size * sign for axis in axes for sign in (-1, 1)]
        _line(shader, vertices, view.color)


def _text(text, x, y, color):
    blf.size(0, 13)
    blf.color(0, *color)
    blf.position(0, x, y, 0)
    blf.draw(0, text)


def _draw_views():
    global _preview_offset
    if _capturing:
        return
    context = bpy.context
    views = _live_views(context)
    if not views:
        return
    for offset in range(len(views)):
        index = (_preview_offset + offset) % len(views)
        view = views[index]
        if view.captured_revision != view.revision:
            _capture(context, view)
            _preview_offset = index + 1
            # Offscreen rendering can change the state of this draw pass.
            # Request the display pass after Blender has finished the current one.
            _schedule_redraw()
            return
    shader = gpu.shader.from_builtin("UNIFORM_COLOR")
    width, height = PREVIEW_SIZE
    left = context.region.width - 2 * (width + 8) - 40
    top = context.region.height - 80
    can_show_previews = left > 150 and top > 5 * (height + 10)
    now = time.monotonic()
    if any(now - view.moved_at < 0.18 for view in views):
        _schedule_redraw()
    for view in views:
        point = location_3d_to_region_2d(
            context.region, context.region_data, view.cursor_position(now)
        )
        if point is not None:
            _text(view.label, point.x + 11, point.y + 11, view.color)
        if not can_show_previews or view.preview is None:
            continue
        x = left + (view.slot % 2) * (width + 8)
        y = top - (view.slot // 2 + 1) * (height + 10)
        draw_texture_2d(view.preview.texture_color, (x, y), width, height)
        corners = [(x, y), (x + width, y), (x + width, y + height), (x, y + height)]
        _line(shader, [corners[index] for index in (0, 1, 1, 2, 2, 3, 3, 0)], view.color)
        _text(view.label, x + 6, y + height - 16, view.color)


@persistent
def _clear_views(*_args):
    if bpy.app.timers.is_registered(request_redraw):
        bpy.app.timers.unregister(request_redraw)
    for view in agents.values():
        if view.preview is not None:
            view.preview.free()
    agents.clear()


def register():
    from . import bridge
    bridge.register()
    _handlers.extend([
        bpy.types.SpaceView3D.draw_handler_add(_draw_cursors, (), "WINDOW", "POST_VIEW"),
        bpy.types.SpaceView3D.draw_handler_add(_draw_views, (), "WINDOW", "POST_PIXEL"),
    ])
    bpy.app.handlers.load_pre.append(_clear_views)


def unregister():
    from . import bridge
    bridge.unregister()
    for handler in _handlers:
        bpy.types.SpaceView3D.draw_handler_remove(handler, "WINDOW")
    _handlers.clear()
    bpy.app.handlers.load_pre.remove(_clear_views)
    _clear_views()
