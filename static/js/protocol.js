// 各基板の通信仕様(各リポジトリの docs/communication_spec.md、docs/can_id_map.md)に基づく、
// 画面を持たない純粋な関数。ブラウザと Node のテスト(tests/)の両方から使う。

export const CAN = {
  ESTOP: 0x001, HEARTBEAT: 0x080,
  HQDD_CMD: 0x100, HQDD_TELEM: 0x200, HQDD_REPLY: 0x300,
  BDCMD_CMD: 0x120, BDCMD_TARGET: 0x140, BDCMD_STATUS: 0x220, BDCMD_REPLY: 0x320, BDCMD_CH: 0x400,
  LDS_A: 0x180, LDS_B: 0x188,
};

export const ascii = (bytes) => String.fromCharCode(...bytes);
export const toBytes = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
export const i16 = (d, o) => { const v = d[o] | (d[o + 1] << 8); return v & 0x8000 ? v - 0x10000 : v; };
export const u16 = (d, o) => d[o] | (d[o + 1] << 8);
export const f32 = (d, o) => new DataView(Uint8Array.from(d.slice(o, o + 4)).buffer).getFloat32(0, true);
export const hex = (d) => d.map((b) => b.toString(16).padStart(2, "0")).join(" ");

/** 数値を、指定の文字数に収まるように有効桁を減らして文字にする(例 0.0149999 -> "0.015")。 */
export function fmtNum(v, maxLen = 8) {
  for (let p = 7; p >= 1; p--) {
    const s = String(+Number(v).toPrecision(p));
    if (s.length <= maxLen) return s;
  }
  return String(Math.round(v));
}

// ---------------- HQDD1 ----------------
export function hqddDecodeCan(id, d, dev) {
  if (id === CAN.HQDD_TELEM + dev && d.length >= 8)
    return { type: "telem", sa: i16(d, 0) / 1000, v: i16(d, 2) / 100, iq: i16(d, 4) / 1000, trq: i16(d, 6) / 1000 };
  if (id === CAN.HQDD_REPLY + dev && d.length >= 8) {
    const k = ascii(d.slice(0, 2));
    if (k === "WS") return { type: "saved", status: d[2] };
    if (k === "FR") return { type: "reset", status: d[2] };
    return d[2] ? { type: "gain", name: k, value: f32(d, 4) } : { type: "log", text: "名前が不明: " + k };
  }
  return null;
}

const KV = /(\w+)=(-?\d+(?:\.\d+)?)/g;
const GAIN = /^GAIN (\w+) (-?\d+(?:\.\d+)?(?:e-?\d+)?)$/;
const status3 = (line, ok, busy) => (line.startsWith(ok) ? 1 : line.includes("BUSY") ? 2 : 0);

/** 行頭の "#<id> " を外す。戻り値: {id, text}(接頭辞なしは id=null)。 */
export function splitPrefix(line) {
  const m = /^#(\d+) (.*)$/.exec(line);
  return m ? { id: +m[1], text: m[2] } : { id: null, text: line };
}

/** HQDD1 の UART 1 行(接頭辞を除いたもの)。 */
export function hqddDecodeLine(text) {
  if (text === "SAVED" || text.startsWith("SAVE ")) return { type: "saved", status: status3(text, "SAVED") };
  if (text.startsWith("RESET ")) return { type: "reset", status: status3(text, "RESET OK") };
  const g = GAIN.exec(text);
  if (g) return { type: "gain", name: g[1], value: +g[2] };
  const kv = Object.fromEntries([...text.matchAll(KV)].map((m) => [m[1], +m[2]]));
  if ("v" in kv && "Iq" in kv)
    return { type: "telem", v: kv.v, tgt: kv.tgt ?? 0, iq: kv.Iq, id: kv.Id ?? 0, vq: kv.Vq ?? 0, sa: kv.sa ?? 0, trq: kv.trq ?? 0, hz: kv.loopHz ?? 0 };
  return { type: "log", text };
}

// ---------------- BDCMD_X1 ----------------
export const BD_FLAGS = [
  ["FAULT", "DRV8874 が異常を検出(過電流・過熱・低電圧)"], ["LOWBAT", "低電圧で停止中"],
  ["TIMEOUT", "通信タイムアウトで停止中"], ["ESTOP", "非常停止中"],
  ["ENC_ERR", "速度・位置モードの ch でエンコーダが読めない"], ["NO_BATT", "電池がつながっていない(USB 給電だけ)"],
  ["ID_CONFLICT", "同じ ID の基板が同じバスにいて停止中"],
];
export const flagNames = (v) => BD_FLAGS.filter((_, i) => v & (1 << i)).map((f) => f[0]);
// bit7 = ABS_POS: 異常ではない印。この版は、位置が電源投入時にエンコーダの絶対角度(AS5600 − AZ)から始まる(main_board がそれを見て、位置を絶対として扱う)
export const BD_FLAG_ABS_POS = 0x80;

export function bdcmdDecodeCan(id, d, dev) {
  if (id === CAN.BDCMD_STATUS + dev && d.length >= 5) {
    const modes = [0, 1, 2, 3].map((c) => (d[3] >> (c * 2)) & 3);
    return { type: "status", vb: u16(d, 0) / 1000, fl: d[2], modes, en: [0, 1, 2, 3].map((c) => !!(d[4] & (1 << c))), enc: [0, 1, 2, 3].map((c) => !!(d[4] & (0x10 << c))) };
  }
  const chBase = CAN.BDCMD_CH + dev * 4;
  if (id >= chBase && id < chBase + 4 && d.length >= 8)
    return { type: "ch", ch: id - chBase + 1, p: i16(d, 0) / 100, v: i16(d, 2) / 100, i: i16(d, 4) / 1000, d: i16(d, 6) / 10 };
  if (id === CAN.BDCMD_REPLY + dev && d.length >= 8) {
    const k = ascii(d.slice(0, 2));
    if (k === "WS") return { type: "saved", status: d[2] };
    if (k === "FR") return { type: "reset", status: d[2] };
    return d[2] ? { type: "gain", name: d[3] + k, value: f32(d, 4) } : { type: "log", text: "名前が不明: " + k };
  }
  return null;
}

/** BDCMD_X1 の UART テレメトリ: "vb=11.92 fl=0 | 1:m=1 d=12.0 p=1.234 v=0.50 i=0.31 | 2:..." */
export function bdcmdDecodeLine(text) {
  if (text === "SAVED" || text.startsWith("SAVE ")) return { type: "saved", status: status3(text, "SAVED") };
  if (text.startsWith("RESET ")) return { type: "reset", status: status3(text, "RESET OK") };
  const g = GAIN.exec(text);
  if (g) return { type: "gain", name: g[1], value: +g[2] };
  if (text.startsWith("vb=")) {
    const parts = text.split("|").map((s) => s.trim());
    const head = Object.fromEntries([...parts[0].matchAll(KV)].map((m) => [m[1], +m[2]]));
    const chs = [];
    for (const p of parts.slice(1)) {
      const m = /^(\d):(.*)$/.exec(p);
      if (m) chs[+m[1] - 1] = Object.fromEntries([...m[2].matchAll(KV)].map((x) => [x[1], +x[2]]));
    }
    return { type: "uart-telem", vb: head.vb, fl: head.fl ?? 0, chs };
  }
  return { type: "log", text };
}

/** 4ch の目標値フレーム(0x140+ID)のデータを作る。null の ch は「変更しない」(-32768)。 */
export function bdcmdTargetFrame(vals, scales) {
  const out = [];
  vals.forEach((v, i) => {
    const n = v == null ? -32768 : Math.max(-32767, Math.min(32767, Math.round(v * scales[i])));
    out.push(n & 0xff, (n >> 8) & 0xff);
  });
  return out;
}

// ---------------- main_board ----------------
function csv(s) { return s.split(",").map((x) => (x === "nan" ? null : +x)); }

export function mainDecodeLine(line) {
  if (line.startsWith("t ")) {
    const o = {};
    for (const tok of line.slice(2).split(/\s+/)) { const [k, v] = tok.split("="); if (v !== undefined) o[k] = v; }
    return { type: "telem", ms: +o.ms, vb: +o.vb, es: +o.es, en: +o.en, src: o.src, v: csv(o.v || ""), w: csv(o.w || ""), s: csv(o.s || ""), enc: csv(o.enc || ""), gz: +o.gz };
  }
  if (line.startsWith("i ")) {
    const o = {};
    for (const tok of line.slice(2).split(/\s+/)) { const [k, v] = tok.split("="); if (v !== undefined) o[k] = v; }
    return { type: "info", text: line.slice(2), fields: o };
  }
  if (line.startsWith("c ")) {
    const m = /^c ([0-9a-fA-F]+) ([0-9a-fA-F]*)$/.exec(line);
    if (m) return { type: "can", id: parseInt(m[1], 16), data: (m[2].match(/../g) || []).map((h) => parseInt(h, 16)) };
  }
  return { type: "log", text: line };
}

export const ESTOP_REASON = [["ボタン(PS/スイッチ)", 0], ["PC(X 1)", 1], ["低電圧", 2]]; // ビットの意味は firmware の docs/firmware.md を参照

// ---------------- LDS01_ESP32 ----------------
export const LDS_SECTORS = ["前", "左前", "左", "左後", "後", "右後", "右", "右前"];

/** UDP パケット(1456 バイト)を解釈する。 */
export function ldsDecodePacket(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 16 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "LDS1") return null;
  const n = dv.getUint16(12, true);
  if (buf.byteLength < 16 + n * 4) return null;
  const dist = new Uint16Array(n), inten = new Uint16Array(n);
  for (let i = 0; i < n; i++) { dist[i] = dv.getUint16(16 + i * 2, true); inten[i] = dv.getUint16(16 + n * 2 + i * 2, true); }
  return { seq: dv.getUint32(4, true), rpm: dv.getUint16(8, true) / 10, vb: dv.getUint16(10, true) / 1000, n, complete: !!(dv.getUint16(14, true) & 1), dist, inten };
}

/** 点 i は ROS の ranges[359-i] と同じ向き(反時計回りが正、0° = 前)。角度 [deg] を返す。 */
export const ldsAngle = (i, n = 360) => (n - 1 - i) * (360 / n);

/** 8 方向の最短距離(セクター k は 前から反時計回りに k×45° を中心とした ±22.5°)。0 = データなし。 */
export function ldsSectors(dist, minMm = 120, maxMm = 3500, offsetDeg = 0) {
  const out = new Array(8).fill(0), n = dist.length;
  for (let i = 0; i < n; i++) {
    const r = dist[i];
    if (r < minMm || r > maxMm) continue;
    const a = (((ldsAngle(i, n) - offsetDeg) % 360) + 360) % 360;
    const k = Math.floor((a + 22.5) / 45) % 8;
    if (!out[k] || r < out[k]) out[k] = r;
  }
  return out;
}

export function ldsDecodeCan(id, d, dev) {
  if ((id === CAN.LDS_A + dev || id === CAN.LDS_B + dev) && d.length >= 8) {
    const base = id === CAN.LDS_A + dev ? 0 : 4;
    return { type: "sectors", base, values: [u16(d, 0), u16(d, 2), u16(d, 4), u16(d, 6)] };
  }
  return null;
}

/** UART1 の行: "s rpm=300.2 d=812,0,1520,..." */
export function ldsDecodeLine(line) {
  const m = /^s rpm=([\d.]+) d=([\d,]+)$/.exec(line);
  if (m) return { type: "sectors8", rpm: +m[1], values: m[2].split(",").map(Number) };
  if (line.startsWith("i ")) {
    const o = {};
    for (const tok of line.slice(2).split(/\s+/)) { const [k, v] = tok.split("="); if (v !== undefined) o[k] = v; }
    return { type: "info", text: line.slice(2), fields: o };
  }
  return { type: "log", text: line };
}

// ---------------- 全基板(CAN 監視) ----------------
/** CAN フレームが、どの基板の何かを返す。 */
export function classifyCan(id) {
  if (id === CAN.ESTOP) return { board: "all", what: "非常停止" };
  if (id === CAN.HEARTBEAT) return { board: "main_board", what: "生存通知" };
  const rng = (base, n) => id >= base && id < base + n;
  if (rng(0x100, 8)) return { board: "hqdd1", dev: id - 0x100, what: "コマンド" };
  if (rng(0x120, 8)) return { board: "bdcmd_x1", dev: id - 0x120, what: "コマンド" };
  if (rng(0x140, 8)) return { board: "bdcmd_x1", dev: id - 0x140, what: "4ch 目標値" };
  if (rng(0x180, 8)) return { board: "lds01_esp32", dev: id - 0x180, what: "距離(前半)" };
  if (rng(0x188, 8)) return { board: "lds01_esp32", dev: id - 0x188, what: "距離(後半)" };
  if (rng(0x200, 8)) return { board: "hqdd1", dev: id - 0x200, what: "テレメトリ", from: true };
  if (rng(0x220, 8)) return { board: "bdcmd_x1", dev: id - 0x220, what: "状態", from: true };
  if (rng(0x300, 8)) return { board: "hqdd1", dev: id - 0x300, what: "応答", from: true };
  if (rng(0x320, 8)) return { board: "bdcmd_x1", dev: id - 0x320, what: "応答", from: true };
  if (rng(0x400, 32)) return { board: "bdcmd_x1", dev: (id - 0x400) >> 2, what: `ch${((id - 0x400) & 3) + 1} テレメトリ`, from: true };
  return { board: null, what: "不明" };
}

// ---------------- ゲームパッド(ブラウザの Gamepad API)→ main_board の G コマンド ----------------
// 標準の配置(Gamepad.mapping === "standard": Xbox、PS4 / PS5、Switch Pro など)。
// G の仕様は main_board の docs/communication_spec.md: G <lx> <ly> <rx> <ry> <l2> <r2> <ボタン(16 進)>
//   スティックは lx / rx が右が正、ly / ry が上が正(Gamepad API は下が正なので ly / ry は反転する)
// ボタンのビット(PS4 の並び): 上 下 左 右 □ × ○ △ L1 R1 L3 R3 SHARE OPTIONS PS タッチパッド
const G_BUTTONS = [12, 13, 14, 15, 2, 0, 1, 3, 4, 5, 10, 11, 8, 9, 16, 17];   // 標準配置のボタン番号
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export function gamepadToG(axes, buttons) {
  const ax = (i) => +(axes[i] || 0), val = (i) => (buttons[i] ? (typeof buttons[i] === "object" ? buttons[i].value ?? (buttons[i].pressed ? 1 : 0) : +buttons[i]) : 0);
  const pressed = (i) => (buttons[i] ? (typeof buttons[i] === "object" ? !!buttons[i].pressed : !!buttons[i]) : false);
  let bits = 0;
  G_BUTTONS.forEach((idx, n) => { if (pressed(idx)) bits |= 1 << n; });
  const f = (v) => (clamp(v, -1, 1) + 0).toFixed(3).replace("-0.000", "0.000");
  return `G ${f(ax(0))} ${f(-ax(1))} ${f(ax(2))} ${f(-ax(3))} ${f(clamp(val(6), 0, 1))} ${f(clamp(val(7), 0, 1))} ${bits.toString(16).toUpperCase()}`;
}

// ---------------- main_board の設定コマンド(K*)の応答 ----------------
// KL(設定の一覧)の応答:
//   cs saved=0 reboot=0 drive=1 wheels=4 steers=0 joints=0 max_joints=8
//   cf <名前> <型> <最小> <最大> <刻み> <今の値> <初期値> <要再起動> <単位>|<ラベル>|<グループ>|<選択肢>     名前 = g.maxVx、d0.gear など
//   ca <d / s / j><番号> <種類> <グループ名> <番号>                                                         (そのアクチュエータの cf の前)
//   ce                                                                                                      (終わり)
// KS / KA / KZ / KB / KR の応答: c ok / c err ... / c applied reboot=1 / c rebooting / c reset ...
export function parseCfgLine(line) {
  let m;
  if (line === "ce") return { type: "ce" };
  if ((m = /^cs (.*)$/.exec(line))) {
    const kv = Object.fromEntries(m[1].split(" ").map((x) => x.split("=")));
    return { type: "cs", saved: +kv.saved, reboot: +kv.reboot, drive: +kv.drive, wheels: +kv.wheels, steers: +kv.steers, joints: +kv.joints, maxJoints: +kv.max_joints };
  }
  if ((m = /^ca (\S+) (\S+) (\S+) (\S+)$/.exec(line))) return { type: "ca", id: m[1], actType: m[2], group: m[3], num: +m[4] };
  if ((m = /^cf (\S+) (\S) (\S+) (\S+) (\S+) (\S+) (\S+) (\d) (.*)$/.exec(line))) {
    const parts = m[9].split("|");   // 選択肢の中にも | があるので、先頭の 3 つだけ分ける
    return { type: "cf", name: m[1], t: m[2], lo: +m[3], hi: +m[4], step: +m[5], v: +m[6], d: +m[7], rb: m[8] === "1", unit: parts[0], label: parts[1], group: parts[2], opts: parts.slice(3).join("|") };
  }
  if ((m = /^c (ok|err|applied|rebooting|reset)\b(.*)$/.exec(line))) return { type: "c", status: m[1], rest: m[2].trim() };
  return null;
}
/** "0:使わない|3:BDCMD_X1 位置" → [[0, "使わない"], [3, "BDCMD_X1 位置"]] */
export const parseOpts = (s) => (s ? s.split("|").map((x) => { const i = x.indexOf(":"); return [+x.slice(0, i), x.slice(i + 1)]; }) : []);
