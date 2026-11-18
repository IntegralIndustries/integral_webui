#!/usr/bin/env python3
"""基板のふりをするシミュレータ。ハードウェアなしで Web UI を試す・動作確認するためのもの。

  --can vcan0   HQDD1(ID 1)、BDCMD_X1(ID 0)、LDS01_ESP32(ID 0)、main_board の生存通知を、CAN 上で演じる
  --udp         main_board(UDP 9100)と LDS01_ESP32(UDP 9200)を localhost で演じる

実機の仕様(各リポジトリの docs/communication_spec.md)に沿って作ってあるが、動力学は簡略化している。
vcan の用意(Linux):  sudo modprobe vcan && sudo ip link add dev vcan0 type vcan && sudo ip link set vcan0 up
使い方:  python3 tools/sim_boards.py --can vcan0 --udp     →  python3 server.py  →  http://localhost:8080
"""
import argparse
import math
import socket
import struct
import threading
import time

CAN_FRAME = "=IB3x8s"


class Can:
    def __init__(self, iface):
        self.s = socket.socket(socket.PF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
        self.s.bind((iface,))
        self.lock = threading.Lock()

    def send(self, cid, data):
        data = bytes(data)[:8]
        with self.lock:
            self.s.send(struct.pack(CAN_FRAME, cid, len(data), data.ljust(8, b"\0")))

    def recv(self, timeout=0.05):
        self.s.settimeout(timeout)
        try:
            cid, dlc, data = struct.unpack(CAN_FRAME, self.s.recv(16))
        except socket.timeout:
            return None
        return cid & 0x7FF, data[:dlc]


def clamp16(v):
    return max(-32768, min(32767, int(round(v))))


# ---------------------------------------------------------------- HQDD1
class Hqdd:
    DEF = dict(VP=0.03, VI=0.03, VD=0.0, VF=0.008, AP=30.0, QP=0.8, QI=60.0, GR=29.16, IL=1.0, VL=60.0, UL=6.0, SV=8.0, AV=5.0)

    def __init__(self, can, dev=1):
        self.can, self.dev = can, dev
        self.p = dict(self.DEF)
        self.mode, self.target, self.sa, self.v, self.en = 1, 0.0, 0.0, 0.0, 1

    def command(self, text):
        t = text
        if t.startswith("?"):
            k = t[1:]
            if k == "MC":
                return self.reply(k, float(self.mode))
            if k in self.p:
                return self.reply(k, self.p[k])
            return self.can.send(0x300 + self.dev, list(k.encode()[:2].ljust(2, b" ")) + [0, 0, 0, 0, 0, 0])
        if t == "S":
            self.mode, self.target = 1, 0.0
        elif t.startswith("MC"):
            self.mode = int(t[2:])
            self.target = self.sa if self.mode == 2 else 0.0
        elif t.startswith("ME"):
            self.en = int(t[2:])
        elif t == "Z":
            self.sa = 0.0
            self.target = 0.0 if self.mode == 2 else self.target
        elif t == "W":
            self.can.send(0x300 + self.dev, [0x57, 0x53, 1, 0, 0, 0, 0, 0])
        elif t == "F":
            self.p = dict(self.DEF)
            self.can.send(0x300 + self.dev, [0x46, 0x52, 1, 0, 0, 0, 0, 0])
        elif t[:1] == "P" or (t[:1] == "M" and t[1:2] in ("V", "A", "Q")):   # "PIL1.5" と "MVP0.02" はどちらも名前が t[1:3]
            try:
                if t[1:3] in self.p:
                    self.p[t[1:3]] = float(t[3:])
            except ValueError:
                pass
        elif t.startswith("M"):
            self.target = float(t[1:])

    def reply(self, name, value):
        self.can.send(0x300 + self.dev, list(name.encode()) + [1, 0] + list(struct.pack("<f", value)))

    def step(self, dt=0.02):
        if self.mode == 1:
            self.v += (self.target - self.v) * 0.15
        elif self.mode == 2:
            self.v = (self.target - self.sa) * 3.0
        else:
            self.v += (self.target / 4 - self.v) * 0.1
        self.v = max(-30, min(30, self.v)) if self.en else 0.0
        self.sa += self.v * dt
        iq = self.v * 0.02 + 0.01 * math.sin(time.time() * 5)
        self.can.send(0x200 + self.dev, struct.pack("<4h", clamp16(self.sa * 1000), clamp16(self.v * 100), clamp16(iq * 1000), clamp16(iq * 29.16 * 0.0367 * 1000)))


# ---------------------------------------------------------------- BDCMD_X1
class Bdcmd:
    BOARD = dict(IL=5.0, TO=500.0, TP=20.0, LV=0.0)
    CH = dict(VP=5.0, VI=50.0, VD=0.0, VF=0.01, AP=5.0, VL=30.0, DL=100.0, GR=1.0, DR=0.0, ED=0.0, EN=0.0)

    def __init__(self, can, dev=0):
        self.can, self.dev = can, dev
        self.b = dict(self.BOARD)
        self.c = [dict(self.CH, EN=float(i + 1)) for i in range(4)]
        self.mode, self.en = [0] * 4, [1] * 4
        self.target, self.pos, self.vel, self.duty = [0.0] * 4, [0.0] * 4, [0.0] * 4, [0.0] * 4
        self.last_cmd = None   # 動作の指令を最後に受けた時刻(通信タイムアウトの再現)
        self.timeout = False

    def motion(self):
        self.last_cmd = time.monotonic()
        self.timeout = False

    def command(self, t):
        chs = range(4)
        if t == "S":
            self.motion()
            for i in chs:
                self.target[i] = self.pos[i] if self.mode[i] == 2 else 0.0
        elif t.startswith("?") and len(t) >= 4:
            ch, name = int(t[1]), t[2:4]
            d = self.b if ch == 0 else self.c[ch - 1]
            if name in ("MC",) and ch:
                v = float(self.mode[ch - 1])
            else:
                v = d.get(name)
            if v is None:
                return self.can.send(0x320 + self.dev, list(name.encode()) + [0, ch, 0, 0, 0, 0])
            self.can.send(0x320 + self.dev, list(name.encode()) + [1, ch] + list(struct.pack("<f", v)))
        elif t.startswith("P") and len(t) >= 5:
            ch, name = int(t[1]), t[2:4]
            d = self.b if ch == 0 else self.c[ch - 1]
            if name in d:
                d[name] = float(t[4:])
        elif t in ("W", "F"):
            if t == "F":
                self.b, self.c = dict(self.BOARD), [dict(self.CH, EN=float(i + 1)) for i in range(4)]
            self.can.send(0x320 + self.dev, [0x57 if t == "W" else 0x46, 0x53 if t == "W" else 0x52, 1, 0, 0, 0, 0, 0])
        elif t[0] in "1234A" and len(t) >= 2:
            targets = chs if t[0] == "A" else [int(t[0]) - 1]
            rest = t[1:]
            for i in targets:
                if rest.startswith("MC"):
                    self.mode[i] = int(rest[2:])
                    self.target[i] = self.pos[i] if self.mode[i] == 2 else 0.0
                elif rest.startswith("ME"):
                    self.en[i] = int(rest[2:])
                elif rest == "S":
                    self.motion(); self.target[i] = self.pos[i] if self.mode[i] == 2 else 0.0
                elif rest == "Z":
                    self.pos[i] = 0.0
                elif rest.startswith("M"):
                    self.motion(); self.target[i] = float(rest[1:])

    def target_frame(self, d):
        self.motion()
        for i in range(4):
            v = struct.unpack_from("<h", bytes(d), i * 2)[0]
            if v != -32768:
                self.target[i] = v / (10 if self.mode[i] == 0 else 100)

    def step(self, dt=0.02):
        if self.last_cmd is not None and self.b["TO"] > 0 and time.monotonic() - self.last_cmd > self.b["TO"] / 1000 and not self.timeout:
            self.timeout = True
            self.target = [self.pos[i] if self.mode[i] == 2 else 0.0 for i in range(4)]
        for i in range(4):
            if not self.en[i]:
                self.vel[i] = self.duty[i] = 0.0
            elif self.mode[i] == 0:
                self.duty[i] = self.target[i]; self.vel[i] += (self.duty[i] * 0.3 - self.vel[i]) * 0.2
            elif self.mode[i] == 1:
                self.vel[i] += (self.target[i] - self.vel[i]) * 0.2; self.duty[i] = self.vel[i] / 0.3
            else:
                self.vel[i] = max(-30, min(30, (self.target[i] - self.pos[i]) * 5)); self.duty[i] = self.vel[i] / 0.3
            self.pos[i] += self.vel[i] * dt
        vb, fl = 11.9, 4 if self.timeout else 0
        modes = sum(m << (2 * i) for i, m in enumerate(self.mode))
        self.can.send(0x220 + self.dev, struct.pack("<HBBB3x", int(vb * 1000), fl, modes, 0x0F | 0xF0))
        for i in range(4):
            wrap = ((self.pos[i] + 327.68) % 655.36) - 327.68   # 実機と同じく int16 で一周する
            self.can.send(0x400 + self.dev * 4 + i, struct.pack("<4h", clamp16(wrap * 100), clamp16(self.vel[i] * 100), clamp16(abs(self.duty[i]) * 8), clamp16(self.duty[i] * 10)))


# ---------------------------------------------------------------- UDP の基板
def udp_main(port=9100):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", port))
    s.settimeout(0.1)
    st = dict(en=0, es=0, v=(0, 0, 0), vt=0.0, tel=False, peer=None)
    t0 = time.monotonic()
    while True:
        try:
            data, peer = s.recvfrom(512)
            st["peer"] = peer
            for line in data.decode().splitlines():
                a = line.split()
                if not a:
                    continue
                if a[0] == "H":
                    s.sendto(b"h", peer)
                elif a[0] == "?":
                    s.sendto(f"i main_board fw 1.0.0 drive={st['en']} wheels=4 vb=11.92 cells=3 estop=0x{st['es']:x} wifi=1 ps4=0 can=1 ip=127.0.0.1".encode(), peer)
                elif a[0] == "D":
                    st["en"] = int(a[1])
                elif a[0] == "X":
                    st["es"] = 2 if a[1] == "1" else 0
                    if st["es"]:
                        st["en"] = 0
                elif a[0] == "V" and st["en"] and not st["es"]:
                    st["v"], st["vt"] = tuple(float(x) for x in a[1:4]), time.monotonic()
                elif a[0] == "T":
                    st["tel"] = a[1] == "1"
                elif a[0] in ("C", "CT", "O", "F"):
                    print("main_board sim:", line)
        except socket.timeout:
            pass
        if time.monotonic() - st["vt"] > 0.3:
            st["v"] = (0, 0, 0)
        if st["tel"] and st["peer"] and int((time.monotonic() - t0) * 10) != st.get("last"):
            st["last"] = int((time.monotonic() - t0) * 10)
            vx, vy, wz = st["v"]
            w = [(vx - vy - wz * 0.3) / 0.05, (vx + vy + wz * 0.3) / 0.05, (vx + vy - wz * 0.3) / 0.05, (vx - vy + wz * 0.3) / 0.05]
            s.sendto((f"t ms={int((time.monotonic()-t0)*1000)} vb=11.92 es={st['es']} en={st['en']} src={'PC' if any(st['v']) else '-'} v={vx:.2f},{vy:.2f},{wz:.2f} "
                      f"w={','.join(f'{x:.1f}' for x in w)} s=0.00,0.00,0.00,0.00 enc=1.23,nan,nan,nan,nan,nan,nan gz={0.01*math.sin(time.time()):.3f}").encode(), st["peer"])


def lds_room(i):
    """矩形の部屋(2.4 m × 3.0 m、LDS は中央付近)と、前方 1 m の柱を、点 i の距離 [mm] にして返す。"""
    th = math.radians(359 - i)       # ROS と同じ向き(反時計回り、0 = 前)
    dx, dy = math.cos(th), math.sin(th)   # x = 前、y = 左
    ds = [(1500 - 0) / dx if dx > 1e-6 else 1e9, (-1500) / dx if dx < -1e-6 else 1e9, 1200 / dy if dy > 1e-6 else 1e9, -1200 / dy if dy < -1e-6 else 1e9]
    r = min(d for d in ds if d > 0)
    if abs(th - 0) < 0.12 or abs(th - 2 * math.pi) < 0.12:
        r = min(r, 1000)
    return int(max(0, min(r, 3500)))


def udp_lds(port=9200):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", port))
    s.settimeout(0.05)
    peer, seen, seq, nxt = None, 0, 0, time.monotonic()
    while True:
        try:
            data, p = s.recvfrom(64)
            cmd = data.decode().strip()
            if cmd == "SUB":
                peer, seen = p, time.monotonic()
            elif cmd == "?":
                s.sendto(b"i lds01_esp32 fw 1.0.0 rpm=300.2 vb=11.90 wifi=1 ip=127.0.0.1 sub=1 sent=%d bad=0 can=1 idc=0" % seq, p)
            elif cmd in ("START", "STOP"):
                s.sendto(b"ok", p)
        except socket.timeout:
            pass
        if peer and time.monotonic() - seen < 3 and time.monotonic() >= nxt:
            nxt = max(nxt + 0.2, time.monotonic() - 0.2)
            dist = [lds_room(i) + (i % 3) for i in range(360)]
            inten = [1200 + int(600 * math.sin(i / 20)) for i in range(360)]
            pkt = b"LDS1" + struct.pack("<IHHHH", seq, 3002, 11900, 360, 1) + struct.pack("<360H", *dist) + struct.pack("<360H", *inten)
            s.sendto(pkt, peer)
            seq += 1


def can_main(can, hq, bd):
    t = time.monotonic()
    while True:
        t += 0.02
        hq.step(); bd.step()
        # LDS01_ESP32(ID 0)の 8 方向(10 Hz)と main_board の生存通知(10 Hz)
        if int(t * 50) % 5 == 0:
            sec = [lds_room(int(359 - k * 45)) for k in range(8)]
            can.send(0x180, struct.pack("<4H", *sec[:4])); can.send(0x188, struct.pack("<4H", *sec[4:]))
            can.send(0x080, struct.pack("<BHB", 0, 11920, 0))
        time.sleep(max(0, t - time.monotonic()))


def can_rx(can, hq, bd):
    while True:
        m = can.recv()
        if not m:
            continue
        cid, d = m
        if cid == 0x100 + hq.dev:
            hq.command(d.decode("ascii", "replace"))
        elif cid == 0x120 + bd.dev:
            bd.command(d.decode("ascii", "replace"))
        elif cid == 0x140 + bd.dev and len(d) == 8:
            bd.target_frame(d)
        elif cid == 0x001 and d[:1] == b"\x01":
            bd.command("S")
            print("非常停止を受信")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--can", metavar="IFACE")
    ap.add_argument("--udp", action="store_true")
    a = ap.parse_args()
    if not (a.can or a.udp):
        ap.error("--can か --udp を指定してください")
    if a.udp:
        threading.Thread(target=udp_main, daemon=True).start()
        threading.Thread(target=udp_lds, daemon=True).start()
        print("UDP: main_board 127.0.0.1:9100 / LDS01_ESP32 127.0.0.1:9200")
    if a.can:
        can = Can(a.can)
        hq, bd = Hqdd(can, 1), Bdcmd(can, 0)
        threading.Thread(target=can_rx, args=(can, hq, bd), daemon=True).start()
        threading.Thread(target=can_main, args=(can, hq, bd), daemon=True).start()
        print(f"CAN({a.can}): HQDD1 ID=1 / BDCMD_X1 ID=0 / LDS01_ESP32 ID=0 / main_board 生存通知")
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
