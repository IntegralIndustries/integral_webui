#!/usr/bin/env python3
"""Integral 基板 Web UI のバックエンド(通信の中継だけを行う)。

ブラウザ <-WebSocket-> このサーバ <-SocketCAN / シリアル / UDP-> 基板

プロトコルの解釈(コマンドの組み立て、テレメトリのデコード)はすべてブラウザ側(static/js)で行う。
サーバは「バイト列を運ぶだけ」なので、基板が増えてもここは変わらない。

起動:  python3 server.py [--port 8080] [--host 127.0.0.1]   ->  http://localhost:8080
依存:  aiohttp, pyserial   (CAN は標準ライブラリの SocketCAN だけ。python-can は不要)

ブラウザ -> サーバ(JSON)
  {type:"open", mode:"can",  iface:"can0", on_close:[tx...]}
  {type:"open", mode:"uart", port:"/dev/ttyUSB0", baud:115200, on_close:[tx...]}
  {type:"open", mode:"udp",  host:"integral-main.local", port:9100, on_close:[tx...]}
  {type:"tx", kind:"can",  id:0x101, data:[77,67,49]}
  {type:"tx", kind:"uart", text:"@1 M2"}
  {type:"tx", kind:"udp",  text:"V 0 0 0"}
  {type:"set_on_close", on_close:[tx...]}
  {type:"close"}
サーバ -> ブラウザ(JSON)
  {type:"status", connected:bool, mode:str|null}
  {type:"can", frames:[[t, id, [bytes]], ...]}        10 ms ごとにまとめて送る
  {type:"line", text:"..."}                            UART の 1 行
  {type:"udp", b64:"..."}                              UDP の 1 パケット
  {type:"error", text:"..."}
on_close は「最後のブラウザが閉じた / 接続を閉じたときに基板へ送る停止コマンド」(安全のため)。
"""
import argparse
import asyncio
import base64
import json
import socket
import struct
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

from aiohttp import web, WSMsgType

try:
    import serial
    import serial.tools.list_ports
except ImportError:  # UART をサーバ経由で使わないなら無くてもよい
    serial = None

STATIC = Path(__file__).parent / "static"
CAN_FRAME = "=IB3x8s"  # struct can_frame


class Link:
    """現在の接続 1 本分(CAN / UART / UDP のどれか)。"""

    def __init__(self, app, mode, on_close):
        self.app, self.mode, self.on_close = app, mode, on_close or []
        self.stop = threading.Event()
        self.sock = self.ser = self.udp = None
        self.udp_addr = None
        self._frames, self._lock = [], threading.Lock()
        self._t0 = time.monotonic()

    def emit(self, msg):
        loop = self.app["loop"]
        loop.call_soon_threadsafe(asyncio.ensure_future, self.app["broadcast"](msg))

    # ---- 開く ----
    def open_can(self, iface):
        s = socket.socket(socket.PF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
        s.bind((iface,))
        s.settimeout(0.2)
        self.sock = s
        threading.Thread(target=self._can_rx, daemon=True).start()
        threading.Thread(target=self._can_flush, daemon=True).start()

    def open_uart(self, port, baud):
        if serial is None:
            raise RuntimeError("pyserial が入っていません(pip install pyserial)")
        self.ser = serial.Serial(port, baud, timeout=0.2)
        threading.Thread(target=self._uart_rx, daemon=True).start()

    async def open_udp(self, host, port):
        loop = asyncio.get_running_loop()
        # mDNS 名(*.local)の解決は時間がかかることがあるので別スレッドで
        addr = (await loop.run_in_executor(None, socket.gethostbyname, host), port)
        link = self

        class Proto(asyncio.DatagramProtocol):
            def datagram_received(self, data, _addr):
                link.emit({"type": "udp", "b64": base64.b64encode(data).decode()})

        self.udp, _ = await loop.create_datagram_endpoint(Proto, local_addr=("0.0.0.0", 0))
        self.udp_addr = addr

    # ---- 送る ----
    def send(self, tx):
        kind = tx.get("kind")
        if kind != self.mode:
            raise RuntimeError(f"{self.mode} で接続中なので {kind} は送れません")
        if kind == "can":
            data = bytes(tx.get("data", []))[:8]
            self.sock.send(struct.pack(CAN_FRAME, int(tx["id"]) & 0x7FF, len(data), data.ljust(8, b"\0")))
        elif kind == "uart":
            self.ser.write((tx["text"].rstrip("\n") + "\n").encode("ascii", "replace"))
        elif kind == "udp":
            self.udp.sendto(tx["text"].encode("utf-8"), self.udp_addr)

    # ---- 受信 ----
    def _can_rx(self):
        while not self.stop.is_set():
            try:
                raw = self.sock.recv(16)
            except socket.timeout:
                continue
            except OSError:
                break
            cid, dlc, data = struct.unpack(CAN_FRAME, raw)
            if cid & 0x80000000 or cid & 0x40000000:  # 拡張 ID・RTR は使わない
                continue
            with self._lock:
                self._frames.append([round(time.monotonic() - self._t0, 4), cid & 0x7FF, list(data[:dlc])])

    def _can_flush(self):
        while not self.stop.is_set():
            time.sleep(0.01)
            with self._lock:
                f, self._frames = self._frames, []
            if f:
                self.emit({"type": "can", "frames": f[-400:]})

    def _uart_rx(self):
        while not self.stop.is_set():
            try:
                line = self.ser.readline().decode("ascii", "replace").strip()
            except Exception as e:  # USB が抜けた等
                self.emit({"type": "error", "text": f"シリアル切断: {e}"})
                self.emit({"type": "status", "connected": False, "mode": None})
                break
            if line:
                self.emit({"type": "line", "text": line})

    def close(self):
        # 基板に停止を送ってから閉じる(失敗しても閉じる)
        for tx in self.on_close:
            try:
                self.send(tx)
            except Exception:
                pass
        self.stop.set()
        for o in (self.sock, self.ser):
            try:
                o and o.close()
            except Exception:
                pass
        if self.udp:
            self.udp.close()


# ------------------------------------------------------------------
async def ports(request):
    p = []
    if serial:
        p = [d.device for d in serial.tools.list_ports.comports() if not d.device.startswith("/dev/ttyS")]
    cans = [n for _, n in socket.if_nameindex() if n.startswith(("can", "vcan", "slcan"))]
    return web.json_response({"serial": sorted(p), "can": cans, "version": 2})


def origin_ok(request):
    """別サイトのページから ws://localhost に繋いでモーターを回されるのを防ぐ。"""
    o = request.headers.get("Origin")
    return o is None or urlparse(o).netloc == request.headers.get("Host")


async def ws_handler(request):
    if not origin_ok(request):
        raise web.HTTPForbidden(text="origin not allowed")
    app = request.app
    ws = web.WebSocketResponse(heartbeat=10)
    await ws.prepare(request)
    app["clients"].add(ws)
    link = app["st"]["link"]
    await ws.send_json({"type": "status", "connected": bool(link), "mode": link.mode if link else None})
    try:
        async for m in ws:
            if m.type != WSMsgType.TEXT:
                continue
            try:
                await handle(app, json.loads(m.data))
            except Exception as e:
                await ws.send_json({"type": "error", "text": str(e)})
    finally:
        app["clients"].discard(ws)
        if not app["clients"] and app["st"]["link"]:  # 最後のブラウザが閉じたら安全のため停止して切断
            app["st"]["link"].close()
            app["st"]["link"] = None
    return ws


async def handle(app, req):
    t, link = req.get("type"), app["st"]["link"]
    if t == "open":
        if link:
            link.close()
            app["st"]["link"] = None
        link = Link(app, req["mode"], req.get("on_close"))
        if link.mode == "can":
            link.open_can(req["iface"])
        elif link.mode == "uart":
            link.open_uart(req["port"], int(req["baud"]))
        elif link.mode == "udp":
            await link.open_udp(req["host"], int(req["port"]))
        else:
            raise RuntimeError("不明な接続方式")
        app["st"]["link"] = link
        await app["broadcast"]({"type": "status", "connected": True, "mode": link.mode})
    elif t == "close":
        if link:
            link.close()
            app["st"]["link"] = None
        await app["broadcast"]({"type": "status", "connected": False, "mode": None})
    elif t == "set_on_close":  # ID を自動検出したあとなど、停止コマンドの宛先が決まってから更新する
        if link:
            link.on_close = req.get("on_close") or []
    elif t == "tx":
        if not link:
            raise RuntimeError("未接続")
        link.send(req)


async def index(request):
    return web.FileResponse(STATIC / "index.html")


def make_app():
    app = web.Application()
    app["clients"] = set()
    app["st"] = {"link": None}   # 起動後に app[...] を書き換えるのは非推奨なので、変更する値は dict に入れる

    async def broadcast(msg):
        for c in list(app["clients"]):
            try:
                await c.send_json(msg)
            except Exception:
                pass

    async def on_start(app):
        app["loop"] = asyncio.get_running_loop()

    app["broadcast"] = broadcast
    app.on_startup.append(on_start)
    app.router.add_get("/", index)
    app.router.add_get("/api/ports", ports)
    app.router.add_get("/ws", ws_handler)
    app.router.add_static("/", STATIC, show_index=False)
    return app


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1", help="既定は自分のPCだけ。0.0.0.0 にすると同じLANの誰でもモーターを動かせるので注意")
    a = ap.parse_args()
    print(f"http://{a.host}:{a.port}")
    web.run_app(make_app(), host=a.host, port=a.port, print=None)


if __name__ == "__main__":
    main()
