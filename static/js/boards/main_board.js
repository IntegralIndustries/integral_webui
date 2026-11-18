// main_board(ESP32 メイン制御基板)。PC からのテキストコマンド(Wi-Fi UDP / USB シリアル)で操縦・出力・CAN 中継をする。
import { mainDecodeLine, classifyCan, hex, toBytes } from "../protocol.js";
import { ChartBoard } from "../chart.js";
import { LogPanel, el } from "../ui.js";
import configTab from "./main_board_config.js";

const SERIES = {
  vx: ["vx(前)", "m/s", 0], vy: ["vy(左)", "m/s", 1], wz: ["wz(旋回)", "rad/s", 2],
  w1: ["車輪1", "rad/s", 0], w2: ["車輪2", "rad/s", 1], w3: ["車輪3", "rad/s", 2], w4: ["車輪4", "rad/s", 3],
  vb: ["電池", "V", 4], gz: ["IMU gz", "rad/s", 5],
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`e${n}`, [`ENC${n}`, "rad", (n - 1) % 8]])),
};
const PRESETS = {
  v: { label: "足回りの速度指令", keys: ["vx", "vy", "wz"], title: "足回りの速度指令" },
  w: { label: "各輪の速度指令", keys: ["w1", "w2", "w3", "w4"], title: "各輪の速度指令" },
  vb: { label: "電池電圧", keys: ["vb"], title: "電池電圧" },
  gz: { label: "IMU 角速度", keys: ["gz"], title: "IMU" },
  enc: { label: "エンコーダ", keys: ["e1", "e2", "e3", "e4"], title: "エンコーダ(ENC1〜4)", pool: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"] },
};
const ES = [[1, "ボタン(PS / SW 長押し)"], [2, "PC (X 1)"], [4, "低電圧"]];

const TEMPLATE = `
<main class="grid">
<aside>
  <div class="card">
    <button class="big-stop" id="estop">■ 非常停止 (X 1)</button>
    <div class="row"><button id="estop0" class="grow">解除 (X 0)</button><button id="zero" class="grow" title="V 0 0 0">速度を 0 に</button></div>
    <div class="small mute">PS4 の PS ボタンでも非常停止します。Esc キーでも止まります。</div>
  </div>
  <div class="card">
    <h2>基板の状態</h2>
    <dl class="kv"><dt>電池</dt><dd id="s_vb" class="val">—</dd><dt>足回り</dt><dd id="s_en">—</dd><dt>操縦の入力</dt><dd id="s_src">—</dd><dt>非常停止</dt><dd id="s_es">—</dd><dt>接続</dt><dd id="s_info" class="small">—</dd></dl>
    <div class="row"><button id="info">情報 (?)</button><button id="tel" title="T 1 / T 0">状態の送信を切替 (T)</button></div>
  </div>
  <div class="card">
    <h2>足回り(PC から操縦)</h2>
    <div class="row"><button id="d1" class="grow">有効 (D 1)</button><button id="d0" class="grow">無効 (D 0)</button></div>
    <div class="small mute" style="margin-bottom:4px">下の円を<b>押している間だけ</b> <code>V</code> を送ります(離すと 0)。キーボード: W/S = 前後、A/D = 左右、Q/E = 旋回。</div>
    <div class="pad" id="pad"><div class="knob" id="knob"></div><span class="lab" style="left:50%;top:1%;transform:translateX(-50%)">前</span><span class="lab" style="left:50%;bottom:1%;transform:translateX(-50%)">後</span><span class="lab" style="left:2%;top:48%">左</span><span class="lab" style="right:2%;top:48%">右</span></div>
    <div class="row"><label style="flex:1">旋回 wz <input type="range" id="wz" min="-1" max="1" step="0.01" value="0"></label></div>
    <div class="row"><label>最大 vx,vy <input type="number" id="maxv" value="0.5" step="0.1" min="0.05" style="width:64px"> m/s</label><label>最大 wz <input type="number" id="maxw" value="1.0" step="0.1" min="0.1" style="width:64px"> rad/s</label></div>
    <div class="val small" id="vcmd">V 0.000 0.000 0.000</div>
    <div class="warn" id="dnote"></div>
    <div class="small mute">PS4 がつながっている間は PC の <code>V</code> は無視されます。ファームの上限(<code>MAX_VX</code> など)を超える値は制限されます。</div>
  </div>
  <div class="card">
    <h2>出力(サーボ / ESC / モーター)</h2>
    <div id="outs"></div>
    <div class="small mute">ESC は足回りで使っているものは不可。<b>ESC・モーターは実際に回ります。</b>0 に戻してから接続・切断してください。</div>
  </div>
  <div class="card">
    <h2>CAN の中継</h2>
    <div class="row"><label>文字列を送る <code>CT</code></label></div>
    <div class="row"><input type="text" id="ct_id" placeholder="ID(16進) 例 120" style="width:90px"><input type="text" id="ct_s" placeholder="文字列 例 1MC1" class="grow"><button id="ct_go">送信</button></div>
    <div class="row"><label>バイト列を送る <code>C</code></label></div>
    <div class="row"><input type="text" id="c_id" placeholder="ID 例 001" style="width:90px"><input type="text" id="c_d" placeholder="データ 例 01" class="grow"><button id="c_go">送信</button></div>
    <div class="row"><label><input type="checkbox" id="fwd">受信した CAN を表示 (F 1)</label></div>
    <div class="row"><button data-ct="120 S">BDCMD(ID0) 全ch停止</button><button data-ct="100 S">HQDD(ID0) 停止</button></div>
    <div id="canlog"></div>
  </div>
  <div class="card"><h2>生コマンド / ログ</h2>
    <div class="row"><input type="text" id="raw" placeholder="例: V 0.2 0 0   O S1 90   (Enterで送信)"></div>
    <div id="logbox"></div><div class="row"><button id="clog">ログ消去</button></div></div>
</aside>
<section id="chartarea"></section>
</main>`;

const stopCmds = () => [{ text: "V 0 0 0" }, { text: "D 0" }, { text: "T 0" }];

export default {
  id: "main_board",
  stopCmds(conn) { return conn.mode === "udp" ? stopCmds().map((t) => ({ kind: "udp", ...t })) : stopCmds().map((t) => ({ kind: "uart", ...t })); },
  extraTabs: [{ id: "config", label: "robot_config.h 作成", mount: configTab }],

  create(ctx) {
    const root = ctx.root;
    root.innerHTML = TEMPLATE;
    const $ = (id) => root.querySelector("#" + id);
    const tr = ctx.transport;
    const log = new LogPanel($("logbox"), 120);
    const canlog = new LogPanel($("canlog"), 110);
    const st = { t0: performance.now(), en: null, telem: false };
    const charts = new ChartBoard($("chartarea"), {
      series: SERIES, presets: PRESETS, storage: "integral_main_charts", initial: [{ keys: ["vx", "vy", "wz"], title: "足回りの速度指令" }, { keys: ["vb"], title: "電池電圧" }],
      csvKeys: Object.keys(SERIES), csvName: "main_board", note: "「状態の送信 (T 1)」が ON のとき 10Hz で更新されます。",
    });

    function send(text, quiet = false) {
      if (!tr.connected) { if (!quiet) log.err("未接続です"); return false; }
      try { ctx.conn().mode === "udp" ? tr.sendUdp(text) : tr.sendLine(text); } catch (e) { log.err(String(e.message || e)); return false; }
      if (!quiet) log.tx(text);
      return true;
    }

    // ---------- 受信 ----------
    function onLine(line) {
      const m = mainDecodeLine(line);
      if (m.type === "telem") {
        st.telem = true;
        const r = { t: (performance.now() - st.t0) / 1000, vx: m.v[0], vy: m.v[1], wz: m.v[2], vb: m.vb, gz: m.gz };
        m.w.forEach((x, i) => (r["w" + (i + 1)] = x));
        m.enc.forEach((x, i) => (r["e" + (i + 1)] = x));
        charts.push(r);
        $("s_vb").textContent = m.vb.toFixed(2) + " V";
        $("s_en").textContent = m.en ? "有効" : "無効";
        $("s_src").textContent = m.src === "PS4" ? "PS4 コントローラ" : m.src === "PC" ? "PC" : "なし";
        const reasons = ES.filter(([b]) => m.es & b).map((x) => x[1]);
        $("s_es").replaceChildren(el("span", { class: "flag " + (reasons.length ? "bad" : "ok") }, reasons.length ? "停止中: " + reasons.join("、") : "なし"));
        st.en = !!m.en;
        ctx.markRx();
      } else if (m.type === "info") {
        const f = m.fields;
        $("s_info").textContent = m.text;
        if (f.vb) $("s_vb").textContent = (+f.vb).toFixed(2) + " V" + (f.cells ? ` (${f.cells}S)` : "");
        if (f.drive) $("s_en").textContent = f.drive === "1" ? "有効" : "無効";
        st.en = f.drive === "1";
        log.add("i " + m.text);
      } else if (m.type === "can") {
        const c = classifyCan(m.id);
        canlog.add(`${m.id.toString(16).padStart(3, "0")}  ${hex(m.data)}  ${c.board ? c.board + (c.dev != null ? "#" + c.dev : "") + " " + c.what : "?"}`);
      } else log.add(line);
    }
    const offs = [
      tr.on("line", ({ text }) => { if (ctx.conn().mode === "uart") onLine(text); }),
      tr.on("udp", ({ bytes }) => { if (ctx.conn().mode === "udp") new TextDecoder().decode(bytes).split(/\r?\n/).forEach((l) => l.trim() && onLine(l.trim())); }),
    ];

    // ---------- 操縦 ----------
    const drive = { x: 0, y: 0, w: 0, hold: false, keys: new Set() };
    const maxv = () => +$("maxv").value || 0.5, maxw = () => +$("maxw").value || 1;
    function current() {
      let x = drive.x, y = drive.y, w = +$("wz").value;
      const k = drive.keys;
      if (k.size) { x = (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0); y = (k.has("a") ? 1 : 0) - (k.has("d") ? 1 : 0); w = (k.has("q") ? 1 : 0) - (k.has("e") ? 1 : 0) || w; }
      return [x * maxv(), y * maxv(), w * maxw()];
    }
    const active = () => drive.hold || drive.keys.size || +$("wz").value !== 0;
    const fmt3 = (v) => (+v).toFixed(3);
    const driveTimer = setInterval(() => {
      const [x, y, w] = current();
      $("vcmd").textContent = `V ${fmt3(x)} ${fmt3(y)} ${fmt3(w)}`;
      if (!tr.connected) return;
      if (active()) { send(`V ${fmt3(x)} ${fmt3(y)} ${fmt3(w)}`, true); drive.sent = true; }
      else if (drive.sent) { send("V 0 0 0", true); drive.sent = false; }   // 離したら 0 を送って止める
      $("dnote").textContent = active() && st.en === false ? "足回りが無効です。「有効 (D 1)」を押してください。" : "";
    }, 50);   // 基板は 300ms 途切れると止まる
    const pad = $("pad"), knob = $("knob");
    const padMove = (e) => {
      const r = pad.getBoundingClientRect();
      let nx = ((e.clientX - r.left) / r.width - 0.5) * 2, ny = ((e.clientY - r.top) / r.height - 0.5) * 2;
      const d = Math.hypot(nx, ny); if (d > 1) { nx /= d; ny /= d; }
      drive.y = -nx; drive.x = -ny;   // 上 = 前(+x)、左 = 左(+y)
      knob.style.left = 50 + nx * 50 + "%"; knob.style.top = 50 + ny * 50 + "%";
    };
    const padEnd = () => { drive.hold = false; drive.x = drive.y = 0; knob.style.left = knob.style.top = "50%"; };
    pad.onpointerdown = (e) => { pad.setPointerCapture(e.pointerId); drive.hold = true; padMove(e); };
    pad.onpointermove = (e) => { if (drive.hold) padMove(e); };
    pad.onpointerup = pad.onpointercancel = padEnd;
    const wz = $("wz"); wz.onpointerup = wz.onpointercancel = () => { wz.value = 0; };   // 離したら 0 に戻す
    const typing = (e) => /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.type !== "range";
    const onKeyDown = (e) => {
      if (e.key === "Escape") return stopAll();
      if (typing(e) || e.repeat) return;
      const k = e.key.toLowerCase();
      if ("wasdqe".includes(k) && k.length === 1) drive.keys.add(k);
    };
    const onKeyUp = (e) => drive.keys.delete(e.key.toLowerCase());
    const onBlur = () => drive.keys.clear();
    document.addEventListener("keydown", onKeyDown); document.addEventListener("keyup", onKeyUp); addEventListener("blur", onBlur);
    function stopAll() { padEnd(); drive.keys.clear(); wz.value = 0; send("V 0 0 0"); drive.sent = false; }
    $("zero").onclick = stopAll;
    $("estop").onclick = () => { stopAll(); send("X 1"); };
    $("estop0").onclick = () => send("X 0");
    $("d1").onclick = () => send("D 1"); $("d0").onclick = () => { stopAll(); send("D 0"); };
    $("info").onclick = () => send("?");
    $("tel").onclick = () => { st.telem = !st.telem; send(st.telem ? "T 1" : "T 0"); };

    // ---------- 出力 ----------
    const outs = $("outs");
    const mkOut = (label, cmdFn, min, max, step, def, unit, extra) => {
      const row = el("div", { class: "row" });
      const lab = el("label", { style: "width:74px" }, label);
      const sl = el("input", { type: "range", min, max, step, value: def, class: "grow" });
      const val = el("span", { class: "val small", style: "width:52px;text-align:right" }, def + unit);
      const upd = () => (val.textContent = sl.value + unit);
      sl.oninput = upd;
      sl.onchange = () => send(cmdFn(sl.value));
      const zero = el("button", { onclick: () => { sl.value = def; upd(); send(cmdFn(def)); } }, extra || "0");
      row.append(lab, sl, val, zero);
      return row;
    };
    for (const n of [1, 2]) {
      const r = mkOut(`サーボ${n}`, (v) => `O S${n} ${v}`, 0, 180, 1, 90, "°", "90");
      r.append(el("button", { onclick: () => send(`O S${n} off`), title: "脱力" }, "脱力"));
      outs.append(r);
    }
    for (const n of [1, 2, 3, 4]) outs.append(mkOut(`ESC${n}`, (v) => `O E${n} ${v}`, -1, 1, 0.01, 0, "", "0"));
    for (const n of [1, 2]) outs.append(mkOut(`モーター${n}`, (v) => `O M${n} ${v}`, 0, 100, 1, 0, "%", "0"));

    // ---------- CAN ----------
    $("ct_go").onclick = () => { const id = $("ct_id").value.trim(), s = $("ct_s").value; if (id && s) send(`CT ${id} ${s}`); };
    $("c_go").onclick = () => { const id = $("c_id").value.trim(), d = $("c_d").value.replace(/\s+/g, ""); if (id) send(`C ${id} ${d}`); };
    $("fwd").onchange = (e) => send(e.target.checked ? "F 1" : "F 0");
    root.querySelectorAll("[data-ct]").forEach((b) => (b.onclick = () => send("CT " + b.dataset.ct)));
    $("raw").onkeydown = (e) => { if (e.key === "Enter" && e.target.value) { send(e.target.value); e.target.value = ""; } };
    $("clog").onclick = () => log.clear();

    return {
      onConnect() {
        st.t0 = performance.now(); st.en = null; st.telem = true;
        if (ctx.conn().mode === "udp") send("H", true);   // UDP の返事の宛先として登録
        setTimeout(() => send("?", true), 150);
        setTimeout(() => send("T 1", true), 300);
      },
      onDisconnect() {},
      destroy() {
        clearInterval(driveTimer); offs.forEach((f) => f()); charts.destroy();
        document.removeEventListener("keydown", onKeyDown); document.removeEventListener("keyup", onKeyUp); removeEventListener("blur", onBlur);
      },
    };
  },
};
