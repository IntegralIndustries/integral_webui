// node --test tests/   (Node 18 以上。依存パッケージなし)
import test from "node:test";
import assert from "node:assert/strict";
import * as P from "../static/js/protocol.js";
import { actExpr, buildParts, check } from "../static/js/boards/main_board_config.js";

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

test("HQDD1: CAN テレメトリ(docs の例 B6 FF 00 00 01 00 01 00)", () => {
  const m = P.hqddDecodeCan(0x201, [0xb6, 0xff, 0, 0, 1, 0, 1, 0], 1);
  near(m.sa, -0.074); assert.equal(m.v, 0); near(m.iq, 0.001); near(m.trq, 0.001);
  assert.equal(P.hqddDecodeCan(0x202, [0, 0, 0, 0, 0, 0, 0, 0], 1), null, "別の ID は無視");
});

test("HQDD1: CAN 応答(?VP -> 0.03)と WS / FR", () => {
  const m = P.hqddDecodeCan(0x301, [0x56, 0x50, 0x01, 0x00, 0x8f, 0xc2, 0xf5, 0x3c], 1);
  assert.equal(m.type, "gain"); assert.equal(m.name, "VP"); near(m.value, 0.03, 1e-5);
  assert.deepEqual(P.hqddDecodeCan(0x301, [0x57, 0x53, 1, 0, 0, 0, 0, 0], 1), { type: "saved", status: 1 });
  assert.deepEqual(P.hqddDecodeCan(0x301, [0x46, 0x52, 2, 0, 0, 0, 0, 0], 1), { type: "reset", status: 2 });
});

test("HQDD1: UART の行", () => {
  assert.deepEqual(P.splitPrefix("#1 v=0.00 tgt=0"), { id: 1, text: "v=0.00 tgt=0" });
  assert.deepEqual(P.splitPrefix("Target: 3"), { id: null, text: "Target: 3" });
  const t = P.hqddDecodeLine("v=0.00 tgt=0.00 Iq=0.01 Id=0.00 Vq=0.09 sa=2.04 trq=0.0057 loopHz=2000");
  assert.equal(t.type, "telem"); near(t.sa, 2.04); near(t.trq, 0.0057); assert.equal(t.hz, 2000);
  assert.deepEqual(P.hqddDecodeLine("GAIN VP 0.03000"), { type: "gain", name: "VP", value: 0.03 });
  assert.deepEqual(P.hqddDecodeLine("SAVE BUSY (回転中)"), { type: "saved", status: 2 });
  assert.deepEqual(P.hqddDecodeLine("RESET OK"), { type: "reset", status: 1 });
});

test("BDCMD_X1: ch テレメトリ(0x400 + ID×4 + ch-1)", () => {
  // 位置 1.23 rad、速度 3.14、電流 250 mA、デューティ 12.5 %
  const d = [123, 0, 0x3a, 0x01, 250, 0, 125, 0];
  const m = P.bdcmdDecodeCan(0x400 + 2 * 4 + 1, d, 2);
  assert.equal(m.ch, 2); near(m.p, 1.23); near(m.v, 3.14); near(m.i, 0.25); near(m.d, 12.5);
  assert.equal(P.bdcmdDecodeCan(0x400 + 2 * 4 + 1, d, 1), null);
  const neg = P.bdcmdDecodeCan(0x400, [0x85, 0xff, 0, 0, 0, 0, 0x18, 0xfc], 0);   // -123 → -1.23 rad、-1000 → -100 %
  near(neg.p, -1.23); near(neg.d, -100);
});

test("BDCMD_X1: 状態(0x220 + ID)とフラグ", () => {
  const m = P.bdcmdDecodeCan(0x220, [0x80, 0x2e, 0b1001000, 0b00_10_01_00, 0b0011_1111, 0, 0, 0], 0);   // 11.904 V
  near(m.vb, 11.904); assert.deepEqual(P.flagNames(m.fl), ["ESTOP", "ID_CONFLICT"]);
  assert.deepEqual(m.modes, [0, 1, 2, 0]); assert.deepEqual(m.en, [true, true, true, true]); assert.deepEqual(m.enc, [true, true, false, false]);
});

test("BDCMD_X1: 応答(ch 付き)と 0x140 の目標値フレーム", () => {
  const r = P.bdcmdDecodeCan(0x320, [0x56, 0x50, 1, 3, 0, 0, 0xa0, 0x40], 0);   // 5.0
  assert.deepEqual([r.type, r.name], ["gain", "3VP"]); near(r.value, 5);
  assert.deepEqual(P.bdcmdTargetFrame([50, -1.57, null, 0], [10, 100, 100, 10]), [0xf4, 0x01, 0x63, 0xff, 0x00, 0x80, 0, 0]);
});

test("BDCMD_X1: UART テレメトリ", () => {
  const m = P.bdcmdDecodeLine("vb=11.92 fl=0 | 1:m=1 d=12.0 p=1.234 v=0.50 i=0.31 | 2:m=0 d=-5.0 p=0.0 v=0.0 i=0.0");
  assert.equal(m.type, "uart-telem"); near(m.vb, 11.92); assert.equal(m.chs[0].m, 1); near(m.chs[0].p, 1.234); near(m.chs[1].d, -5); assert.equal(m.chs[2], undefined);
  assert.deepEqual(P.bdcmdDecodeLine("GAIN 1VE 4.98"), { type: "gain", name: "1VE", value: 4.98 });
});

test("数値の整形(CAN の 8 文字制限)", () => {
  assert.equal(P.fmtNum(0.0149999, 8), "0.015");
  assert.equal(P.fmtNum(12.5, 4), "12.5");
  assert.equal(P.fmtNum(0.0123456, 4), "0.01");
  assert.ok(P.fmtNum(1 / 3, 6).length <= 6);
});

test("main_board: 状態行・情報行・CAN 転送", () => {
  const t = P.mainDecodeLine("t ms=12345 vb=11.92 es=0 en=1 src=PC v=0.50,0.00,0.30 w=10.2,9.8,10.2,9.8 s=0.00 enc=1.23,nan,0.5,nan,nan,nan,nan gz=0.012");
  assert.equal(t.type, "telem"); assert.equal(t.src, "PC"); assert.deepEqual(t.v, [0.5, 0, 0.3]); assert.equal(t.enc[1], null); near(t.gz, 0.012);
  const i = P.mainDecodeLine("i main_board fw 1.0.0 drive=1 wheels=4 vb=11.92 cells=3 estop=0x0 wifi=1 ps4=0 can=1 ip=192.168.1.40");
  assert.equal(i.fields.cells, "3"); assert.equal(i.fields.ip, "192.168.1.40");
  assert.deepEqual(P.mainDecodeLine("c 401 2C010A0000000000"), { type: "can", id: 0x401, data: [0x2c, 1, 0x0a, 0, 0, 0, 0, 0] });
});

test("LDS: パケットの解釈、角度の向き、8 方向", () => {
  const n = 360, b = new Uint8Array(1456), dv = new DataView(b.buffer);
  b.set([0x4c, 0x44, 0x53, 0x31]); dv.setUint32(4, 7, true); dv.setUint16(8, 3002, true); dv.setUint16(10, 11900, true); dv.setUint16(12, n, true); dv.setUint16(14, 1, true);
  const put = (i, mm) => dv.setUint16(16 + i * 2, mm, true);
  put(0, 1000);     // i=0 は ROS の ranges[359] = -1°(ほぼ前)
  put(270, 800);    // 359-270 = 89° = 左
  put(180, 500);    // 179° = 後ろ
  put(5, 50);       // 近すぎ → 無効
  const p = P.ldsDecodePacket(b);
  assert.equal(p.seq, 7); near(p.rpm, 300.2); near(p.vb, 11.9); assert.ok(p.complete);
  assert.equal(P.ldsAngle(0), 359); assert.equal(P.ldsAngle(270), 89);
  assert.deepEqual(P.ldsSectors(p.dist), [1000, 0, 800, 0, 500, 0, 0, 0]);
  assert.equal(P.ldsDecodePacket(new Uint8Array(1456)), null, "ヘッダが違う");
});

test("LDS: CAN と UART", () => {
  assert.deepEqual(P.ldsDecodeCan(0x188, [1, 0, 2, 0, 3, 0, 4, 0], 0), { type: "sectors", base: 4, values: [1, 2, 3, 4] });
  assert.deepEqual(P.ldsDecodeLine("s rpm=300.2 d=812,0,1520,3011,0,0,642,903"), { type: "sectors8", rpm: 300.2, values: [812, 0, 1520, 3011, 0, 0, 642, 903] });
});

test("CAN ID の分類(can_id_map.md)", () => {
  assert.deepEqual(P.classifyCan(0x001), { board: "all", what: "非常停止" });
  assert.equal(P.classifyCan(0x203).board, "hqdd1"); assert.equal(P.classifyCan(0x203).dev, 3);
  assert.equal(P.classifyCan(0x41d).board, "bdcmd_x1"); assert.equal(P.classifyCan(0x41d).dev, 7);
  assert.equal(P.classifyCan(0x188 + 2).dev, 2);
  assert.equal(P.classifyCan(0x7ff).board, null);
});

test("robot_config.h の生成", () => {
  assert.equal(actExpr({ t: "bdcmd", id: 0, ch: 2, ratio: 19, inv: true }), "Act::bdcmd(0, 2).ratio(19.0f).inv()");
  // .offset はサーボだけ。BDCMD / HQDD の位置は .initial か外部エンコーダ
  assert.equal(actExpr({ t: "bdcmdPos", id: 1, ch: 1, ratio: 1, inv: false, off: 0.12 }), "Act::bdcmdPos(1, 1)");
  assert.equal(actExpr({ t: "servo", id: 1, ratio: 1, inv: false, off: 0.12 }), "Act::servo(1).offset(0.12f)");
  assert.equal(actExpr({ t: "bdcmdPos", id: 1, ch: 1, ratio: 1, inv: false, init: 0.5 }), "Act::bdcmdPos(1, 1).initial(0.5f)");
  // 操舵: 外部エンコーダ(.initial は使わない)、可動範囲、速さ
  assert.equal(actExpr({ t: "hqddPos", id: 2, ratio: 1, inv: false, ep: 3, er: 1, ez: 1.23, ei: true, et: 5, init: 0.5, lo: -1.7, hi: 1.7, rate: 4 }),
    "Act::hqddPos(2).enc(3, 1.0f).encZero(1.23f).encInverted().encTrack(5.0f).limit(-1.7f, 1.7f).maxRate(4.0f)");
  assert.equal(actExpr({ t: "hqddPos", id: 2, ratio: 1, inv: false, lo: "", hi: 1.5, rate: "" }), "Act::hqddPos(2).limit(-ANGLE_NO_LIMIT, 1.5f)");
  assert.equal(actExpr({ t: "hqddPos", id: 2, ratio: 1, inv: false }), "Act::hqddPos(2)", "古い保存データ(新しい項目なし)でも壊れない");
  assert.equal(actExpr({ t: "escPid", id: 1, max: 60, enc: 1, encRatio: 1, ratio: 1 }), "Act::escPid(1, 60.0f, 1, 1.0f)");
  const c = { control: "CONTROL_PS4", wifi: true, start: true, mac: "aa:bb", maxvx: 1, maxvy: 1, maxwz: 3, normal: 0.5, slow: 0.2, drive: "DRIVE_MECANUM4", radius: 0.05, lx: 0.15, ly: 0.15,
    pos: [[0.15, 0.15], [0.15, -0.15], [-0.15, 0.15], [-0.15, -0.15]],
    wheels: [1, 2, 3, 4].map((ch) => ({ t: "bdcmd", id: 0, ch, ratio: 1, inv: false, off: 0 })), steer: [1, 2, 3, 4].map(() => ({ t: "none" })) };
  const txt = buildParts(c).map((p) => p[1]).join("\n");
  assert.match(txt, /DRIVE_TYPE = DRIVE_MECANUM4;/); assert.match(txt, /Act::bdcmd\(0, 4\),/);
  assert.deepEqual(check(c), []);
  c.wheels[1].ch = 1;
  assert.match(check(c).join(), /重複/);
});

test("robot_config.h: 実物のファイルのすべての項目を書き換えられる(隣のリポジトリがあるときだけ)", async (t) => {
  const fs = await import("node:fs"), path = new URL("../../main_board/firmware/src/config/robot_config.h", import.meta.url);
  if (!fs.existsSync(path)) return t.skip("main_board リポジトリが隣にない");
  const src = fs.readFileSync(path, "utf8");
  const c = { control: "CONTROL_PC", wifi: true, start: false, mac: "aa:bb:cc:dd:ee:ff", maxvx: 1.5, maxvy: 1, maxwz: 3, normal: 0.5, slow: 0.2, drive: "DRIVE_SWERVE4", radius: 0.05, lx: 0.15, ly: 0.15,
    pos: [[0.15, 0.15], [0.15, -0.15], [-0.15, 0.15], [-0.15, -0.15]], wheels: [1, 2, 3, 4].map((i) => ({ t: "esc", id: i, max: 60, ratio: 1, inv: false, off: 0 })),
    steer: [1, 2, 3, 4].map((i) => ({ t: "hqddPos", id: i, ratio: 1, inv: false, ep: i, er: 1, ez: 0.5, lo: -1.7, hi: 1.7 })) };
  let out = src;
  for (const [re, rep] of buildParts(c)) { assert.match(out, re, "見つからない: " + rep.split("\n")[0]); out = out.replace(re, rep); }
  assert.match(out, /constexpr DriveType DRIVE_TYPE = DRIVE_SWERVE4;/);
  assert.ok(out.includes("ESC_CAL"), "ほかの部分は残る");
  assert.match(out, /Act::hqddPos\(4\)\.enc\(4, 1\.0f\)\.encZero\(0\.5f\)\.limit\(-1\.7f, 1\.7f\),/);
  assert.deepEqual(check(c).filter((x) => /重複|1 回転/.test(x)), [], "ENC 1〜4 が別々なら重複なし");
});

// ---------------- DFU(STM32 の USB 書き込み)。実機が無いので、DfuSe の状態遷移を真似たモックで確かめる ----------------
import { DfuSeDevice, parseLayout, pagesFor } from "../static/js/boards/flasher.js";

test("DFU: メモリ配置の解釈と、消去するページ", () => {
  const s = parseLayout("@Internal Flash  /0x08000000/64*002Kg");
  assert.deepEqual(s, [{ start: 0x08000000, size: 2048, count: 64 }]);
  assert.deepEqual(pagesFor(s, 0x08000000, 2049), [0x08000000, 0x08000800]);
  assert.equal(pagesFor(s, 0x08000000, 128 * 1024 + 1), null, "128 KB を超える");
  assert.equal(pagesFor(s, 0x08020000, 10), null);
});

test("DFU: 消去 → アドレス設定 → ブロック書き込み → 起動の順序", async () => {
  const calls = []; let state = 2, busy = 0;
  const usb = {
    configuration: { interfaces: [{ interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 0xfe, interfaceSubclass: 1, interfaceName: "@Internal Flash  /0x08000000/64*002Kg" }] }] },
    async open() {}, async claimInterface() {}, async selectAlternateInterface() {}, async close() {},
    async controlTransferIn(s, n) {
      if (s.request === 6) return { data: new DataView(Uint8Array.of(9, 2, 27, 0, 1, 1, 0, 0x80, 50, 9, 0x21, 0x0b, 255, 0, 0x00, 0x08, 0x1a, 1, 0).buffer) };
      const st = busy > 0 ? (busy--, 4) : state;   // 命令のあと、最初の 1 回は BUSY(timeout 1 ms)を返す
      if (st === 4) { return { data: new DataView(Uint8Array.of(0, 1, 0, 0, 4, 0).buffer) }; }
      state = 5; return { data: new DataView(Uint8Array.of(0, 0, 0, 0, state, 0).buffer) };
    },
    async controlTransferOut(s, d) { calls.push([s.request, s.value, Array.from(d || [])]); if (s.request === 1) busy = 1; return { status: "ok" }; },
  };
  const dev = new DfuSeDevice(usb); await dev.open();
  assert.equal(dev.xfer, 0x0800 > 2048 ? 2048 : 0x0800, "転送サイズは 2048 まで");
  const data = new Uint8Array(3000).map((_, i) => i & 255);
  await dev.write(0x08000000, data, () => {});
  const dn = calls.filter((c) => c[0] === 1);
  assert.deepEqual(dn[0], [1, 0, [0x41, 0, 0, 0, 8]], "最初のページを消去");
  assert.deepEqual(dn[1], [1, 0, [0x41, 0, 8, 0, 8]], "2 ページ目");
  assert.deepEqual(dn[2], [1, 0, [0x21, 0, 0, 0, 8]], "アドレス設定");
  assert.equal(dn[3][1], 2); assert.equal(dn[3][2].length, 2048); assert.equal(dn[4][1], 3); assert.equal(dn[4][2].length, 952);
  assert.equal(dn[4][2][0], 2048 & 255);
  await dev.leave(0x08000000);
  assert.deepEqual(calls.at(-1), [1, 0, []], "最後は長さ 0 の DNLOAD");
});

test("ゲームパッド(Gamepad API)→ G コマンド", () => {
  // 標準配置: 左スティックを左・上に倒す(Gamepad API は 左 = −1、上 = −1)→ G は lx = −1(右が正)、ly = +1(上が正)
  const axes = [-1, -1, 0, 0];
  const btn = Array.from({ length: 18 }, () => ({ pressed: false, value: 0 }));
  btn[0].pressed = true;                 // A = ×(bit5 = 0x20)
  btn[9].pressed = true;                 // Start = OPTIONS(bit13 = 0x2000)
  btn[4].pressed = true;                 // L1(bit8 = 0x100)
  btn[7] = { pressed: true, value: 0.5 };   // R2
  assert.equal(P.gamepadToG(axes, btn), "G -1.000 1.000 0.000 0.000 0.000 0.500 2120");
  assert.equal(P.gamepadToG([], []), "G 0.000 0.000 0.000 0.000 0.000 0.000 0");
});
