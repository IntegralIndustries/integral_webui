// LDS01_ESP32 の firmware/src/config.h のうち、運用で変える値だけをフォームから作る。
// (Wi-Fi の SSID・パスワードは secrets.h に書く値なので、ここでは扱わない。)
import { el, esc, localGet, localSet } from "../ui.js";

const F = (v) => { const n = +v; return (Number.isInteger(n) ? n.toFixed(1) : String(+n.toPrecision(6))) + "f"; };
const FIELDS = [
  { k: "id", l: "CAN の ID (0〜7)", note: "同じ ID の LDS01_ESP32 を 2 台つなぐと CAN の送信が止まります。1 台ごとに変える", min: 0, max: 7, step: 1,
    re: /^constexpr uint8_t LDS_BOARD_ID = [^;]*;/m, make: (v) => `constexpr uint8_t LDS_BOARD_ID = ${v};` },
  { k: "off", l: "「前」の向きの補正 [deg]", note: "LDS をロボットに斜めに付けたとき。ROS の /scan と同じ向き(反時計回りが正)に足す角度", min: -180, max: 180, step: 1,
    re: /^constexpr float SECTOR_FRONT_OFFSET_DEG = [^;]*;/m, make: (v) => `constexpr float SECTOR_FRONT_OFFSET_DEG = ${F(v)};` },
  { k: "port", l: "UDP のポート", note: "ROS 2 ノード側と合わせる(既定 9200)", min: 1, max: 65535, step: 1,
    re: /^constexpr uint16_t UDP_PORT = [^;]*;/m, make: (v) => `constexpr uint16_t UDP_PORT = ${v};` },
  { k: "rmin", l: "有効な最短距離 [mm]", note: "LDS-01 の仕様は 120", min: 0, max: 3500, step: 10,
    re: /^constexpr uint16_t RANGE_MIN_MM = [^;]*;/m, make: (v) => `constexpr uint16_t RANGE_MIN_MM = ${v};` },
  { k: "rmax", l: "有効な最長距離 [mm]", note: "LDS-01 の仕様は 3500", min: 0, max: 3500, step: 10,
    re: /^constexpr uint16_t RANGE_MAX_MM = [^;]*;/m, make: (v) => `constexpr uint16_t RANGE_MAX_MM = ${v};` },
];
const BOOLS = [{ k: "u1", l: "J6(UART1)に 8 方向の距離を出す", re: /^constexpr bool UART1_OUTPUT = [^;]*;/m, make: (v) => `constexpr bool UART1_OUTPUT = ${v ? "true" : "false"};` }];
const DEF = { id: 0, off: 0, port: 9200, rmin: 120, rmax: 3500, u1: true };

export default function mount(root) {
  const c = { ...DEF, ...(localGet("integral_lds_config", {}) || {}) };
  let source = null;
  root.innerHTML = `<div class="info"><div class="cols" style="grid-template-columns:minmax(320px,520px) minmax(0,1fr)">
    <div class="card"><h2>設定</h2><div id="form"></div></div>
    <div class="card"><h2>出力</h2>
      <div class="row"><button type="button" id="pick">既存の config.h を読み込む</button><input type="file" id="file" accept=".h,text/plain" hidden><span id="fname" class="small mute">未読み込み(貼り付け用の抜粋を出します)</span></div>
      <div id="warns"></div><pre class="out" id="out"></pre>
      <div class="row"><button class="pri" id="copy">コピー</button><button id="dl">ファイルとして保存</button></div>
      <div class="small mute">反映先: <code>lds01_esp32/firmware/src/config.h</code>。保存したら <code>cd firmware && pio run -t upload</code>。Wi-Fi の設定は <code>secrets.h</code>(<code>secrets.example.h</code> をコピー)に書きます。</div></div></div></div>`;
  const $ = (id) => root.querySelector("#" + id);
  $("form").innerHTML = FIELDS.map((f) => `<div class="row"><label style="min-width:170px">${esc(f.l)}</label><input type="number" data-k="${f.k}" value="${c[f.k]}" min="${f.min}" max="${f.max}" step="${f.step}" style="width:90px"></div><div class="small mute" style="margin:-2px 0 6px">${esc(f.note)}</div>`).join("")
    + BOOLS.map((f) => `<div class="row"><label><input type="checkbox" data-k="${f.k}" ${c[f.k] ? "checked" : ""}>${esc(f.l)}</label></div>`).join("");
  function out() {
    const parts = [...FIELDS, ...BOOLS].map((f) => [f.re, f.make(c[f.k])]);
    if (!source) return { text: parts.map((p) => p[1]).join("\n"), miss: [] };
    let t = source; const miss = [];
    for (const [re, rep] of parts) re.test(t) ? (t = t.replace(re, rep)) : miss.push(rep);
    return { text: t, miss };
  }
  function update() {
    localSet("integral_lds_config", c);
    const o = out(), w = [];
    if (c.rmin >= c.rmax) w.push("最短距離は最長距離より小さくしてください");
    if (c.id < 0 || c.id > 7) w.push("ID は 0〜7 です");
    w.push(...o.miss.map((m) => "更新できなかった行: " + m));
    $("out").textContent = o.text;
    $("warns").innerHTML = w.length ? `<div class="note w">${w.map((x) => "・" + esc(x)).join("<br>")}</div>` : "";
  }
  root.querySelectorAll("[data-k]").forEach((e) => (e.onchange = () => { c[e.dataset.k] = e.type === "checkbox" ? e.checked : +e.value; update(); }));
  $("pick").onclick = () => $("file").click();
  $("file").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; source = await f.text(); $("fname").textContent = `${f.name} を読み込みました。該当する行だけを書き換えます`; update(); };
  $("copy").onclick = async () => { try { await navigator.clipboard.writeText($("out").textContent); $("copy").textContent = "コピーしました"; setTimeout(() => ($("copy").textContent = "コピー"), 1200); } catch {} };
  $("dl").onclick = () => { const a = el("a", { href: URL.createObjectURL(new Blob([$("out").textContent], { type: "text/plain" })), download: source ? "config.h" : "config_snippet.h" }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
  update();
  return { destroy() {} };
}
