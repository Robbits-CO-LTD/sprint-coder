"""Loopback bridge polled on Blender's main thread."""

import base64
from dataclasses import dataclass, field
import hmac
import json
import socket
import time
from secrets import token_urlsafe

import bpy
from bpy.app.handlers import persistent

from .session import TeamSceneSession

MAX_REQUEST = 8192
MAX_PEERS = 24
DEADLINE = 12.0


@dataclass
class Connection:
    socket: socket.socket
    opened_at: float = field(default_factory=time.monotonic)
    request: bytearray = field(default_factory=bytearray)
    response: memoryview | None = None
    observation: tuple[str, str] | None = None
    disconnect: bool = False


class BlenderBridge:
    def __init__(self, scene, targets):
        self.session = TeamSceneSession(scene, targets)
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            self.listener.bind(("127.0.0.1", 0))
            self.listener.listen(MAX_PEERS)
            self.listener.setblocking(False)
        except OSError:
            self.listener.close()
            raise
        self.token = token_urlsafe(32)
        self.session_token = None
        self.port = self.listener.getsockname()[1]
        self.peers = []
        self.closed = False

    @property
    def pairing_code(self):
        return f"blender1:{self.port}:{self.token}"

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.listener.close()
        for peer in self.peers:
            peer.socket.close()
        self.peers.clear()
        self.session.close()

    def tick(self):
        if self.closed or bpy.context.scene != self.session.scene:
            self.close()
            return None
        while len(self.peers) < MAX_PEERS:
            try:
                client, _ = self.listener.accept()
            except BlockingIOError:
                break
            client.setblocking(False)
            self.peers.append(Connection(client))
        for peer in self.peers[:]:
            try:
                done = time.monotonic() - peer.opened_at > DEADLINE or self._step(peer)
            except OSError:
                done = True
            if done:
                peer.socket.close()
                self.peers.remove(peer)
                if peer.disconnect:
                    self.close()
                    return None
        return 0.025

    def _step(self, peer):
        try:
            if peer.response is not None:
                peer.response = peer.response[peer.socket.send(peer.response):]
                return len(peer.response) == 0
            if peer.observation is not None:
                # Requests keep the write half open until the response. A disconnected
                # Worker has no pending request to serve after a viewport capture.
                try:
                    peer.socket.recv(1, socket.MSG_PEEK)
                    return True
                except BlockingIOError:
                    pass
                result = self.session.read_observation(*peer.observation)
                if result is not None:
                    png = result.pop("png")
                    result["dataUrl"] = "data:image/png;base64," + base64.b64encode(png).decode()
                    self._reply(peer, ok=True, result=result)
                return False
            chunk = peer.socket.recv(MAX_REQUEST + 1 - len(peer.request))
            if not chunk:
                return True
            peer.request.extend(chunk)
            if len(peer.request) > MAX_REQUEST:
                return True
            if b"\n" in peer.request:
                line, trailing = peer.request.split(b"\n", 1)
                if trailing:
                    return True
                self._dispatch(peer, json.loads(line))
        except BlockingIOError:
            pass
        except (KeyError, TypeError, ValueError, ReferenceError, OverflowError, RuntimeError) as error:
            self._reply(peer, ok=False, error=str(error))
        return False

    @staticmethod
    def _reply(peer, **value):
        peer.response = memoryview(json.dumps(value, allow_nan=False).encode() + b"\n")

    def _dispatch(self, peer, request):
        if not isinstance(request, dict):
            raise ValueError("Invalid Blender request")
        method = request.get("method")
        token = request.get("token")
        expected = self.token if method == "pair" else self.session_token
        if (expected is None or not isinstance(token, str) or not token.isascii()
                or not hmac.compare_digest(token, expected)):
            self._reply(peer, ok=False, error="Invalid Blender pairing code or session")
            return
        if method == "pair":
            targets = [obj.name for obj in self.session.targets]
            self.session_token = token_urlsafe(32)
            self.token = None
            self._reply(peer, ok=True, result={"token": self.session_token, "targets": targets})
            return
        if method in {"status", "disconnect"}:
            peer.disconnect = method == "disconnect"
            self._reply(peer, ok=True, result=True)
            return
        worker = request["worker"]
        if not isinstance(worker, str) or not 1 <= len(worker) <= 128:
            raise ValueError("Invalid Worker identity")
        if method == "bind":
            self.session.bind(worker, request["slot"])
            result = {"bound": True}
        elif method == "observe":
            observation = self.session.begin_observation(
                worker, request["azimuth"], request["elevation"], request.get("faceIndex")
            )
            peer.observation = (worker, observation)
            return
        elif method == "edit":
            result = self.session.edit(
                worker, request["observation"], request["operation"], request["value"]
            )
        elif method == "release":
            self.session.release(worker)
            result = {"released": True}
        else:
            raise ValueError("Unknown Blender operation")
        self._reply(peer, ok=True, result=result)


_bridge = None


@persistent
def stop_bridge(*_args):
    global _bridge
    if _bridge is not None:
        if bpy.app.timers.is_registered(_bridge.tick):
            bpy.app.timers.unregister(_bridge.tick)
        _bridge.close()
        _bridge = None


class SPRINTTEAM_OT_pair(bpy.types.Operator):
    bl_idname = "sprint_team.pair"
    bl_label = "Start pairing"

    def execute(self, context):
        global _bridge
        if _bridge is not None and not _bridge.closed:
            return {"CANCELLED"}
        targets = sorted(context.selected_objects, key=lambda obj: obj.name)
        try:
            _bridge = BlenderBridge(context.scene, targets)
        except (OSError, ValueError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        bpy.app.timers.register(_bridge.tick)
        return {"FINISHED"}


class SPRINTTEAM_OT_copy_code(bpy.types.Operator):
    bl_idname = "sprint_team.copy_code"
    bl_label = "Copy pairing code"

    def execute(self, context):
        if _bridge is None or _bridge.closed or _bridge.token is None:
            return {"CANCELLED"}
        context.window_manager.clipboard = _bridge.pairing_code
        self.report({"INFO"}, "Pairing code copied")
        return {"FINISHED"}


class SPRINTTEAM_OT_disconnect(bpy.types.Operator):
    bl_idname = "sprint_team.disconnect"
    bl_label = "Disconnect"

    def execute(self, _context):
        stop_bridge()
        return {"FINISHED"}


class SPRINTTEAM_PT_team(bpy.types.Panel):
    bl_label = "Sprint Coder Team"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Team"

    def draw(self, _context):
        if _bridge is None or _bridge.closed:
            self.layout.label(text="Select up to 10 mesh objects")
            self.layout.operator(SPRINTTEAM_OT_pair.bl_idname)
        else:
            self.layout.label(text=f"{len(_bridge.session.targets)} paired targets")
            if _bridge.token is not None:
                self.layout.operator(SPRINTTEAM_OT_copy_code.bl_idname)
            self.layout.operator(SPRINTTEAM_OT_disconnect.bl_idname)


CLASSES = (SPRINTTEAM_OT_pair, SPRINTTEAM_OT_copy_code,
           SPRINTTEAM_OT_disconnect, SPRINTTEAM_PT_team)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.app.handlers.load_pre.append(stop_bridge)


def unregister():
    stop_bridge()
    bpy.app.handlers.load_pre.remove(stop_bridge)
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
