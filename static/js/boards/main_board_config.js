// main_board の firmware/src/config/robot_config.h を、フォームから作る。
// 足回りの種類や各輪をどの基板で動かすかは「ビルド時の設定」なので、実行中の基板には送れない。
// そのため、コードを生成して、書き込み(pio run -t upload)の前に robot_config.h へ反映する。
// 既存の robot_config.h を読み込めば、その中の該当する行だけを書き換えて、ほかの部分(ESC・サーボ・通信の設定など)はそのまま残す。
import { el, esc, localGet, localSet } from "../ui.js";

const DRIVES = [
  ["DRIVE_MECANUM4", "メカナム 4 輪(左前・右前・左後・右後)", 4, false], ["DRIVE_OMNI3", "オムニ 3 輪", 3, false], ["DRIVE_OMNI4", "オムニ 4 輪", 4, false],
  ["DRIVE_SWERVE3", "独立ステア 3 輪", 3, true], ["DRIVE_SWERVE4", "独立ステア 4 輪", 4, true], ["DRIVE_NONE", "足回りなし(機構だけ)", 0, false],
];
const DRIVE_ACTS = [["none", "使わない"], ["bdcmd", "BDCMD_X1 速度(エンコーダ要)"], ["bdcmdDuty", "BDCMD_X1 デューティ(開ループ)"], ["hqdd", "HQDD1 速度"], ["esc", "ESC(開ループ)"], ["escPid", "ESC + エンコーダで速度PID"]];
const STEER_ACTS = [["none", "使わない"], ["bdcmdPos", "BDCMD_X1 位置(エンコーダ要)"], ["hqddPos", "HQDD1 位置"], ["servo", "サーボ(±90°)"]];

const DEFAULTS = {
  control: "CONTROL_PS4", wifi: true, start: true, mac: "ec:e3:34:91:04:ca", maxvx: 1, maxvy: 1, maxwz: 3, normal: 0.5, slow: 0.2,
  drive: "DRIVE_MECANUM4", radius: 0.05, lx: 0.15, ly: 0.15,
  pos: [[0.15, 0.15], [0.15, -0.15], [-0.15, 0.15], [-0.15, -0.15]],
  wheels: [0, 1, 2, 3].map((i) => ({ t: "bdcmd", id: 0, ch: i + 1, max: 60, enc: i + 1, encRatio: 1, inv: false, ratio: 1, off: 0 })),
  // 操舵: lo / hi = 可動範囲 [rad](空 = 無制限)、rate = 最大速度 [rad/s](空 = 制限なし)、init = 電源投入時の操舵角(エンコーダなし)、
  //       ep = 外部エンコーダのポート(0 = 使わない)、er = 比、ez = 操舵角 0 のときのエンコーダの角度、ei = 逆向き、et = 補正の時定数
  steer: [0, 1, 2, 3].map((i) => ({ t: "none", id: 1, ch: i + 1, max: 0, enc: 1, encRatio: 1, inv: false, ratio: 1, off: 0, lo: "", hi: "", rate: "", init: 0, ep: 0, er: 1, ez: 0, ei: false, et: 0 })),
};

const F = (v) => { const n = +v; return (Number.isInteger(n) ? n.toFixed(1) : String(+n.toPrecision(6))) + "f"; };

/** アクチュエータ 1 つの指定を C++ の式にする。 */
export function actExpr(a) {
  let s;
  switch (a.t) {
    case "bdcmd": s = `Act::bdcmd(${a.id}, ${a.ch})`; break;
    case "bdcmdDuty": s = `Act::bdcmdDuty(${a.id}, ${a.ch}, ${F(a.max)})`; break;
    case "bdcmdPos": s = `Act::bdcmdPos(${a.id}, ${a.ch})`; break;
    case "hqdd": s = `Act::hqdd(${a.id})`; break;
    case "hqddPos": s = `Act::hqddPos(${a.id})`; break;
    case "esc": s = `Act::esc(${a.id}, ${F(a.max)})`; break;
    case "escPid": s = `Act::escPid(${a.id}, ${F(a.max)}, ${a.enc}, ${F(a.encRatio)})`; break;
    case "servo": s = `Act::servo(${a.id})`; break;
    default: return "Act::none()";
  }
  if (+a.ratio !== 1) s += `.ratio(${F(a.ratio)})`;
  if (a.inv) s += ".inv()";
  const isPos = a.t.endsWith("Pos"), has = (v) => v !== "" && v != null && Number.isFinite(+v);
  if (isPos && +(a.ep ?? 0) > 0) {   // 外部エンコーダ(電源投入時の操舵角を絶対角度で知る)
    s += `.enc(${+a.ep}, ${F(a.er ?? 1)}).encZero(${F(a.ez ?? 0)})`;
    if (a.ei) s += ".encInverted()";
    if (+a.et > 0) s += `.encTrack(${F(a.et)})`;
  } else if (isPos && has(a.init) && +a.init !== 0) s += `.initial(${F(a.init)})`;
  if (a.t === "servo" && +a.off !== 0) s += `.offset(${F(a.off)})`;   // .offset はサーボだけ(BDCMD / HQDD は .initial か外部エンコーダ)
  if ((isPos || a.t === "servo") && (has(a.lo) || has(a.hi))) s += `.limit(${has(a.lo) ? F(a.lo) : "-ANGLE_NO_LIMIT"}, ${has(a.hi) ? F(a.hi) : "ANGLE_NO_LIMIT"})`;
  if ((isPos || a.t === "servo") && has(a.rate) && +a.rate > 0) s += `.maxRate(${F(a.rate)})`;
  return s;
}

const actBlock = (name, list) => `constexpr Act ${name}[4] = {\n${list.map((a) => `  ${actExpr(a)},`).join("\n")}\n};`;

/** 設定の値から、robot_config.h の該当部分を行ごとに作る。キー = 置き換え対象を探す正規表現。 */
export function buildParts(c) {
  const d = DRIVES.find((x) => x[0] === c.drive);
  const parts = [
    [/^#define CONTROL_MODE .*$/m, `#define CONTROL_MODE ${c.control}`],
    [/^#define USE_WIFI .*$/m, `#define USE_WIFI ${c.wifi ? 1 : 0}`],
    [/^constexpr bool DRIVE_START_ENABLED = [^;]*;/m, `constexpr bool DRIVE_START_ENABLED = ${c.start ? "true" : "false"};`],
    [/^#define PS4_HOST_MAC .*$/m, `#define PS4_HOST_MAC "${c.mac}"`],
    [/^constexpr float MAX_VX = [^;]*;/m, `constexpr float MAX_VX = ${F(c.maxvx)};`],
    [/^constexpr float MAX_VY = [^;]*;/m, `constexpr float MAX_VY = ${F(c.maxvy)};`],
    [/^constexpr float MAX_WZ = [^;]*;/m, `constexpr float MAX_WZ = ${F(c.maxwz)};`],
    [/^constexpr float SPEED_NORMAL = [^;]*;/m, `constexpr float SPEED_NORMAL = ${F(c.normal)};`],
    [/^constexpr float SPEED_SLOW = [^;]*;/m, `constexpr float SPEED_SLOW = ${F(c.slow)};`],
    [/^constexpr DriveType DRIVE_TYPE = [^;]*;/m, `constexpr DriveType DRIVE_TYPE = ${c.drive};`],
    [/^constexpr float WHEEL_RADIUS = [^;]*;/m, `constexpr float WHEEL_RADIUS = ${F(c.radius)};`],
    [/^constexpr float MECANUM_LX = [^;]*;/m, `constexpr float MECANUM_LX = ${F(c.lx)};`],
    [/^constexpr float MECANUM_LY = [^;]*;/m, `constexpr float MECANUM_LY = ${F(c.ly)};`],
    [/^constexpr WheelPos WHEEL_POS\[4\] = \{[\s\S]*?\n\};/m, `constexpr WheelPos WHEEL_POS[4] = {\n${c.pos.map(([x, y], i) => `  {${x >= 0 ? "+" : ""}${F(x)}, ${y >= 0 ? "+" : ""}${F(y)}},  // ${i + 1}: ${["左前", "右前", "左後", "右後"][i]}`).join("\n")}\n};`],
    [/^constexpr Act DRIVE_ACT\[4\] = \{[\s\S]*?\n\};/m, actBlock("DRIVE_ACT", c.wheels.map((w, i) => (i < d[2] ? w : { t: "none" })))],
    [/^constexpr Act STEER_ACT\[4\] = \{[\s\S]*?\n\};/m, actBlock("STEER_ACT", c.steer.map((w, i) => (d[3] && i < d[2] ? w : { t: "none" })))],
  ];
  return parts;
}

export function check(c) {
  const d = DRIVES.find((x) => x[0] === c.drive), w = [];
  const used = new Map();
  const use = (key, label) => { if (used.has(key)) w.push(`${label} が ${used.get(key)} と重複しています(${key})`); else used.set(key, label); };
  for (let i = 0; i < d[2]; i++) {
    for (const [lab, a] of [[`車輪${i + 1}`, c.wheels[i]], [`操舵${i + 1}`, d[3] ? c.steer[i] : { t: "none" }]]) {
      if (a.t.startsWith("bdcmd")) use(`BDCMD ID${a.id} ch${a.ch}`, lab);
      if (a.t.startsWith("hqdd")) use(`HQDD ID${a.id}`, lab);
      if (a.t.startsWith("esc")) use(`ESC${a.id}`, lab);
      if (a.t === "servo") use(`サーボ${a.id}`, lab);
      if (a.t === "none" && lab.startsWith("車輪")) w.push(`${lab} が「使わない」です`);
      if (a.t === "escPid") use(`ENC${a.enc}`, lab + " のエンコーダ");
      if ((a.t.startsWith("bdcmd") && (a.ch < 1 || a.ch > 4)) || (a.t.startsWith("bdcmd") || a.t.startsWith("hqdd")) && (a.id < 0 || a.id > 7)) w.push(`${lab}: ID は 0〜7、ch は 1〜4 です`);
      if ((a.t === "bdcmdDuty" || a.t === "esc" || a.t === "escPid") && !(+a.max > 0)) w.push(`${lab}: 最高速度を指定してください`);
    }
  }
  if (d[3]) for (let i = 0; i < d[2]; i++) {
    const a = c.steer[i];
    if (!(a.t.endsWith("Pos") || a.t === "servo")) continue;
    const lo = a.lo === "" || a.lo == null ? null : +a.lo, hi = a.hi === "" || a.hi == null ? null : +a.hi;
    if (lo != null && hi != null && lo >= hi) w.push(`操舵${i + 1}: 可動範囲の最小が最大以上です`);
    if (lo != null && hi != null && hi - lo < Math.PI) w.push(`操舵${i + 1}: 可動範囲が 180° 未満です。届かない向きは、端まで回して車輪の速度を落とします`);
    if (+(a.ep ?? 0) > 0) {
      use(`ENC${a.ep}`, `操舵${i + 1} のエンコーダ`);
      if (lo != null && hi != null && (hi - lo) * Math.abs(a.er ?? 1) > 2 * Math.PI) w.push(`操舵${i + 1}: 可動範囲 × エンコーダ比が 1 回転(2π)を超えています。起動時の角度を 1 回転分間違えます`);
    } else if (a.t !== "servo" && +a.init === 0) w.push(`操舵${i + 1}: 外部エンコーダがないので、電源を入れるとき操舵を「角度 0(真っすぐ前)」にしておいてください(0 でなければ起動時の角度を指定)`);
  }
  if (d[3]) w.push("独立ステアは、各輪が「駆動」と「操舵」の 2 つのアクチュエータを使います。操舵を「使わない」にすると向きが変わりません。");
  if (c.control === "CONTROL_PC") w.push("PC 操縦では Bluetooth を使いません(PS4 では操縦できません)。この UI や ROS から送る「ゲームパッド(G)」は使えます。");
  if (!c.wifi) w.push("Wi-Fi を使わない設定です。基板の Web UI、UDP、ROS 2(UDP)は使えません(USB は使えます)。");
  return w;
}

export default function mount(root, ctx) {
  const c = { ...structuredClone(DEFAULTS), ...(localGet("integral_robot_config", {}) || {}) };
  if (c.control !== "CONTROL_PS4" && c.control !== "CONTROL_PC") c.control = "CONTROL_PS4";   // 古い保存(AUTO / PS4_ONLY / PC_ONLY)
  let source = null;   // 読み込んだ robot_config.h
  root.innerHTML = `<div class="info cfg"><div class="cols" style="grid-template-columns:minmax(320px,520px) minmax(0,1fr)">
    <div id="form"></div>
    <div><div class="card"><h2>出力</h2>
      <div class="row"><label class="btnlike"><input type="file" id="file" accept=".h,text/plain" hidden><button type="button" id="pick">既存の robot_config.h を読み込む</button></label><span id="fname" class="small mute">未読み込み(貼り付け用の抜粋を出します)</span></div>
      <div id="warns"></div>
      <pre class="out" id="out"></pre>
      <div class="row"><button class="pri" id="copy">コピー</button><button id="dl">ファイルとして保存</button></div>
      <div class="small mute">反映先: <code>main_board/firmware/src/config/robot_config.h</code>。保存したら <code>cd firmware && pio run -t upload</code> で書き込みます。</div></div>
    </div></div></div>`;
  const $ = (id) => root.querySelector("#" + id);
  const form = $("form");

  const opts = (list, cur) => list.map((x) => `<option value="${x[0]}" ${x[0] === cur ? "selected" : ""}>${esc(x[1])}</option>`).join("");
  const num = (k, v, step = "any", w = 70) => `<input type="number" data-k="${k}" value="${v}" step="${step}" style="width:${w}px">`;

  function actRow(kind, i) {
    const a = c[kind][i], list = kind === "wheels" ? DRIVE_ACTS : STEER_ACTS, t = a.t;
    const isB = t.startsWith("bdcmd"), isH = t.startsWith("hqdd");
    return `<tr data-kind="${kind}" data-i="${i}"><td>${kind === "wheels" ? "車輪" : "操舵"}${i + 1}</td>
      <td><select data-f="t">${opts(list, t)}</select></td>
      <td>${t === "none" ? "" : `${isB || isH ? "ID" : t === "servo" ? "サーボ" : "ESC"} ${num2("id", a.id)}${isB ? ` ch ${num2("ch", a.ch)}` : ""}${t === "bdcmdDuty" || t === "esc" || t === "escPid" ? ` 最高 ${num2("max", a.max, 56)} rad/s` : ""}${t === "escPid" ? ` ENC ${num2("enc", a.enc, 44)} 比 ${num2("encRatio", a.encRatio, 52)}` : ""}`}</td>
      <td>${t === "none" ? "" : `<label><input type="checkbox" data-f="inv" ${a.inv ? "checked" : ""}>反転</label> 減速比 ${num2("ratio", a.ratio, 52)}${t === "servo" ? ` サーボの 0 点 ${num2("off", a.off, 56)}rad` : ""}`}</td></tr>${detail()}`;
    function nb(f, v, w) { return `<input type="number" data-f="${f}" value="${v ?? ""}" step="any" style="width:${w}px">`; }
    function detail() {
      if (kind !== "steer" || !(t.endsWith("Pos") || t === "servo")) return "";
      const enc = isB || isH;
      return `<tr data-kind="${kind}" data-i="${i}"><td></td><td colspan="3" class="small">
        可動範囲 ${nb("lo", a.lo, 62)} 〜 ${nb("hi", a.hi, 62)} rad(空 = 無制限。例 ±1.7) 　最大速度 ${nb("rate", a.rate, 52)} rad/s
        ${enc ? `<br>外部エンコーダ ENC ${nb("ep", a.ep ?? 0, 40)}(0 = 使わない)　比 ${nb("er", a.er ?? 1, 48)}　操舵角 0 のときの値 ${nb("ez", a.ez ?? 0, 62)} rad <label><input type="checkbox" data-f="ei" ${a.ei ? "checked" : ""}>逆向き</label>　補正 ${nb("et", a.et ?? 0, 44)} s
          <br>${+(a.ep ?? 0) > 0 ? "電源を入れたときの操舵角を、エンコーダの絶対角度から求めます。「操舵角 0 のときの値」は、基板の Web UI の「今の位置を 0 にする」で登録できます。" : `電源を入れたときの操舵角 ${nb("init", a.init ?? 0, 56)} rad(エンコーダなしのとき)`}` : ""}</td></tr>`;
    }
    function num2(f, v, w = 44) { return `<input type="number" data-f="${f}" value="${v}" step="any" style="width:${w}px">`; }
  }

  function render() {
    const d = DRIVES.find((x) => x[0] === c.drive);
    form.innerHTML = `
    <div class="card"><h2>1. 操縦の入力</h2>
      <div class="row"><select data-k="control"><option value="CONTROL_PS4">PS4 コントローラ(Bluetooth)で操縦</option><option value="CONTROL_PC">PC の速度指令(V / ROS の cmd_vel)で操縦(Bluetooth 不使用)</option></select></div>
      <div class="row"><label><input type="checkbox" data-k="wifi" ${c.wifi ? "checked" : ""}>Wi-Fi を使う(Web UI・UDP・ROS 2)</label></div>
      <div class="row"><label><input type="checkbox" data-k="start" ${c.start ? "checked" : ""}>起動したときから足回りを有効にする</label></div>
      <div class="row"><label>PS4 に書き込んだ接続先 MAC <input type="text" data-k="mac" value="${esc(c.mac)}" style="width:170px"></label></div>
      <div class="row"><label>最大 vx ${num("maxvx", c.maxvx)}m/s</label><label>vy ${num("maxvy", c.maxvy)}m/s</label><label>wz ${num("maxwz", c.maxwz)}rad/s</label></div>
      <div class="row"><label>PS4 の速度倍率: 通常 ${num("normal", c.normal)} 低速(L1) ${num("slow", c.slow)}</label></div></div>
    <div class="card"><h2>2. 足回りの種類</h2>
      <div class="row"><select data-k="drive">${opts(DRIVES, c.drive)}</select></div>
      <div class="row"><label>車輪の半径 ${num("radius", c.radius)}m</label></div>
      ${c.drive === "DRIVE_MECANUM4" ? `<div class="row"><label>中心から車輪まで 前後 LX ${num("lx", c.lx)}m 左右 LY ${num("ly", c.ly)}m</label></div>` : ""}
      ${c.drive.startsWith("DRIVE_OMNI") || c.drive.startsWith("DRIVE_SWERVE") ? `<div class="small mute">各輪の位置(中心から。x = 前、y = 左)[m]</div><table class="t">${c.pos.slice(0, d[2]).map((p, i) => `<tr><td>車輪${i + 1}</td><td>x <input type="number" data-pos="${i}" data-a="0" value="${p[0]}" step="any" style="width:70px"></td><td>y <input type="number" data-pos="${i}" data-a="1" value="${p[1]}" step="any" style="width:70px"></td></tr>`).join("")}</table>` : ""}</div>
    <div class="card"><h2>3. 各輪を何で動かすか</h2>
      ${d[2] ? `<table class="t">${[...Array(d[2]).keys()].map((i) => actRow("wheels", i)).join("")}${d[3] ? [...Array(d[2]).keys()].map((i) => actRow("steer", i)).join("") : ""}</table>` : `<div class="mute">足回りなしです。</div>`}
      <div class="small mute" style="margin-top:6px">BDCMD_X1 / HQDD1 側のゲイン・減速比・エンコーダの向きは、各基板のパラメータ(「BDCMD_X1」「HQDD1」の画面)で設定して保存してください。ここで決めるのは、main_board がどの基板のどの ch を使うかです。</div></div>`;
    form.querySelectorAll("[data-k]").forEach((e) => {
      if (e.tagName === "SELECT") e.value = c[e.dataset.k];
      e.onchange = () => { c[e.dataset.k] = e.type === "checkbox" ? e.checked : e.type === "number" ? +e.value : e.value; if (e.dataset.k === "drive") render(); update(); };
    });
    form.querySelectorAll("[data-pos]").forEach((e) => (e.onchange = () => { c.pos[+e.dataset.pos][+e.dataset.a] = +e.value; update(); }));
    form.querySelectorAll("tr[data-kind]").forEach((tr) => {
      const a = c[tr.dataset.kind][+tr.dataset.i];
      tr.querySelectorAll("[data-f]").forEach((e) => (e.onchange = () => {
        const f = e.dataset.f;
        a[f] = e.type === "checkbox" ? e.checked : e.type === "number" ? (e.value === "" && (f === "lo" || f === "hi" || f === "rate") ? "" : +e.value) : e.value;
        if (f === "t" || f === "ep") render();
        update();
      }));
    });
    update();
  }

  function text() {
    const parts = buildParts(c);
    if (source) {
      let out = source, miss = [];
      for (const [re, rep] of parts) { if (re.test(out)) out = out.replace(re, rep); else miss.push(rep.split("\n")[0]); }
      return { text: out, miss };
    }
    return { text: parts.map((p) => p[1]).join("\n"), miss: [] };
  }

  function update() {
    localSet("integral_robot_config", c);
    const { text: t, miss } = text();
    $("out").textContent = t;
    const w = [...check(c), ...miss.map((m) => `読み込んだファイルに該当する行が見つからず、更新できませんでした: ${m}`)];
    $("warns").innerHTML = w.length ? `<div class="note w">${w.map((x) => "・" + esc(x)).join("<br>")}</div>` : "";
  }

  $("pick").onclick = () => $("file").click();
  $("file").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    source = await f.text();
    $("fname").textContent = `${f.name} を読み込みました。該当する行だけを書き換えます`;
    update();
  };
  $("copy").onclick = async () => { try { await navigator.clipboard.writeText($("out").textContent); $("copy").textContent = "コピーしました"; setTimeout(() => ($("copy").textContent = "コピー"), 1200); } catch { /* 権限がないとき */ } };
  $("dl").onclick = () => {
    const a = el("a", { href: URL.createObjectURL(new Blob([$("out").textContent], { type: "text/plain" })), download: source ? "robot_config.h" : "robot_config_snippet.h" });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  render();
  return { destroy() {} };
}
