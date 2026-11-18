// BDCMD_X1(4ch ブラシモータードライバ)。docs/communication_spec.md に従う。
import { CAN, bdcmdDecodeCan, bdcmdDecodeLine, bdcmdTargetFrame, splitPrefix, toBytes, fmtNum, flagNames, BD_FLAGS } from "../protocol.js";
import { ChartBoard } from "../chart.js";
import { LogPanel, ParamEditor, el, esc } from "../ui.js";
import { uartSelect, uartAutoDetector } from "./common.js";
import { dfuFlasher } from "./flasher.js";

const MODES = ["デューティ", "速度", "位置"];
const MODE_UNIT = ["%", "rad/s", "rad"];
const SCALE = [10, 100, 100];                    // 0x140 フレームの単位: 0.1% / 0.01 rad/s / 0.01 rad
const RANGE0 = [100, 30, 12.57];                 // スライダーの初期範囲(±)
const CH_COLOR = [0, 1, 2, 3];

const mk = (pref, label, unit) => [1, 2, 3, 4].map((c) => [`${pref}${c}`, [`ch${c} ${label}`, unit, CH_COLOR[c - 1]]]);
const mkT = (pref, label, unit) => [1, 2, 3, 4].map((c) => [`${pref}${c}`, [`ch${c} 目標`, unit, CH_COLOR[c - 1], 1]]);
const SERIES = Object.fromEntries([
  ...mk("p", "位置", "rad"), ...mkT("tp", "", "rad"),
  ...mk("v", "速度", "rad/s"), ...mkT("tv", "", "rad/s"),
  ...mk("i", "電流", "A"), ...mk("d", "デューティ", "%"), ...mkT("td", "", "%"),
]);
const keys = (p) => [1, 2, 3, 4].map((c) => p + c);
const PRESETS = {
  vel: { label: "速度(全ch + 目標)", keys: [...keys("v"), ...keys("tv")], pool: [...keys("v"), ...keys("tv")], title: "速度" },
  pos: { label: "位置(全ch + 目標)", keys: [...keys("p"), ...keys("tp")], pool: [...keys("p"), ...keys("tp")], title: "位置" },
  cur: { label: "電流(全ch)", keys: keys("i"), pool: keys("i"), title: "電流(推定)" },
  duty: { label: "デューティ(全ch + 目標)", keys: [...keys("d"), ...keys("td")], pool: [...keys("d"), ...keys("td")], title: "デューティ" },
};

// ---- パラメータ(2 章) ----
const BOARD_PARAMS = [
  { n: "IL", l: "電流制限", u: "A", lo: 0.1, hi: 7.3, note: "DRV8874 の I_trip。4ch 共通。超えると出力を一定時間切って制限" },
  { n: "TO", l: "通信タイムアウト", u: "ms", lo: 0, hi: 60000, note: "動作の指令が途切れたら全chを止める。0 = 無効(手で試すとき)" },
  { n: "TP", l: "CAN テレメトリ周期", u: "ms", lo: 5, hi: 1000 },
  { n: "LV", l: "低電圧で止める", u: "V", lo: 0, hi: 30, note: "0 = 無効。LiPo を使うなら設定する(2S は 6.6、3S は 9.9 が目安)" },
];
const CH_PARAMS = [
  { n: "VP", l: "速度 P", u: "%/(rad/s)", lo: 0, hi: 10000 }, { n: "VI", l: "速度 I", u: "%/rad", lo: 0, hi: 100000 },
  { n: "VD", l: "速度 D", u: "%/(rad/s²)", lo: 0, hi: 1000 }, { n: "VF", l: "速度 LPF", u: "s", lo: 0, hi: 1 },
  { n: "AP", l: "位置 P", u: "(rad/s)/rad", lo: 0, hi: 10000 },
  { n: "VL", l: "速度上限", u: "rad/s", lo: 0.1, hi: 10000, note: "出力軸" },
  { n: "DL", l: "デューティ上限", u: "%", lo: 0, hi: 100 },
  { n: "GR", l: "減速比", lo: 0.001, hi: 10000, note: "エンコーダ軸の回転数 / 出力軸の回転数(出力軸に付けたら 1)" },
  { n: "DR", l: "モーター方向反転", lo: 0, hi: 1, note: "1 で反転" },
  { n: "ED", l: "エンコーダ方向反転", lo: 0, hi: 1, note: "1 で反転" },
  { n: "EN", l: "使うエンコーダ", lo: 0, hi: 4, note: "ポート番号(0 = なし)。既定は ch と同じ番号" },
];

const TEMPLATE = `
<main class="grid">
<aside>
  <div class="card">
    <button class="big-stop" id="stop">■ 全ch停止 (S)</button>
    <div class="row"><button id="x1" class="danger grow" title="CANの0x001と同じ。全chの出力を0(ブレーキ)にする">非常停止 (X1)</button><button id="x0" class="grow">解除 (X0)</button></div>
  </div>
  <div class="card">
    <h2>基板の状態</h2>
    <dl class="kv"><dt>電池電圧</dt><dd class="val" id="vb">—</dd><dt>フラグ</dt><dd><div class="chips" id="flags"><span class="flag">—</span></div></dd><dt>ID</dt><dd id="idv">—</dd></dl>
    <div class="small mute" id="flaghelp" style="margin-top:6px"></div>
  </div>
  <div class="card">
    <h2>通信タイムアウト対策</h2>
    <label style="display:flex;gap:6px;align-items:flex-start"><input type="checkbox" id="keep" checked><span>目標値を 200ms ごとに送り続ける<br><span class="small">基板は、動作の指令が <b>500ms</b>(既定)途切れると全chを止めます。この UI が開いている間は、最後に指令した目標を送り続けて動かし続けます。</span></span></label>
  </div>
  <div class="card"><h2>基板全体の設定 (ch=0)</h2><div id="bparams"></div></div>
  <div class="card">
    <h2>チャンネルごとの設定</h2>
    <div class="row"><label>対象 ch</label><div class="seg grow" id="chsel"><button data-c="1" class="on">1</button><button data-c="2">2</button><button data-c="3">3</button><button data-c="4">4</button></div></div>
    <div id="cparams"></div>
    <div class="small mute">ゲインの出荷値は仮の値です。モーターと減速比に合わせて調整してください(手順は bdcmd_x1 の docs/firmware.md の 5 章)。</div>
  </div>
  <div class="card">
    <h2>設定の保存・初期化 (全ch・基板全体)</h2>
    <div class="row"><button id="gall">全て読込</button><button id="gsave" class="pri" title="停止中に押す。どれかのchでデューティが1%を超えていると拒否される">フラッシュに保存 (W)</button><span id="gdirty" class="small val"></span></div>
    <div class="row"><button id="gfactory" class="danger">出荷状態に戻す (F)</button></div>
    <div class="small mute">プログラムを書き込み直すと、保存内容は出荷値に戻ります。調整した値は <code>firmware/src/motor.cpp</code> の初期値にも反映してください。</div>
  </div>
  <div class="card"><h2>生コマンド / ログ</h2>
    <div class="row"><input type="text" id="raw" placeholder="例: 1M30   1MC1   P1VP2.5   ?1VE   (Enterで送信)"></div>
    <div id="logbox"></div><div class="row"><button id="clog">ログ消去</button></div></div>
</aside>
<section>
  <div class="chgrid" id="chgrid" style="margin-bottom:12px"></div>
  <div id="chartarea"></div>
</section>
</main>`;

function stopCmds(conn) {
  if (conn.devId < 0) return [];
  return conn.mode === "can" ? [{ kind: "can", id: CAN.BDCMD_CMD + conn.devId, data: [0x53] }] : [{ kind: "uart", text: `@${conn.devId} S` }];
}

export default {
  id: "bdcmd_x1",
  stopCmds,
  extraTabs: [{ id: "flash", label: "ファームウェア書き込み", mount: dfuFlasher("bdcmd_x1") }],

  create(ctx) {
    const root = ctx.root;
    root.innerHTML = TEMPLATE;
    const $ = (id) => root.querySelector("#" + id);
    const tr = ctx.transport;
    const log = new LogPanel($("logbox"), 130);
    const ch = [0, 1, 2, 3].map(() => ({ mode: 0, en: true, target: 0, sent: false, p: 0, v: 0, i: 0, d: 0, off: 0, last: null, range: null }));
    const state = { sel: 1, dirty: false, t0: performance.now(), active: false, vals: { 0: {}, 1: {}, 2: {}, 3: {}, 4: {} }, enc: [false, false, false, false] };

    const charts = new ChartBoard($("chartarea"), {
      series: SERIES, presets: PRESETS, storage: "integral_bdcmd_charts",
      initial: [{ keys: [...keys("v"), ...keys("tv")], pool: [...keys("v"), ...keys("tv")], title: "速度" }, { keys: keys("i"), pool: keys("i"), title: "電流(推定)" }],
      csvKeys: [...keys("p"), ...keys("v"), ...keys("i"), ...keys("d")], csvName: "bdcmd_x1",
      note: "CANは既定20ms、UARTは200msで更新されます。",
    });

    // ---------- 送信 ----------
    function cmd(text) {
      const c = ctx.conn();
      if (!tr.connected) return log.err("未接続です");
      try {
        if (c.mode === "can") {
          if (text.length > 8) return log.err(`CANは8文字まで(${text.length}文字): ${text}`);
          if (c.devId < 0) return log.err("デバイスID検出待ち(テレメトリ受信後に送信できます)");
          tr.sendCan(CAN.BDCMD_CMD + c.devId, toBytes(text));
        } else {
          if (c.devId < 0) return log.err("IDを検出中です。少し待ってください");
          tr.sendLine(`@${c.devId} ${text}`);
        }
      } catch (e) { return log.err(String(e.message || e)); }
      log.tx(text);
    }
    const quiet = (text) => { try { const c = ctx.conn(); c.mode === "can" ? tr.sendCan(CAN.BDCMD_CMD + c.devId, toBytes(text)) : tr.sendLine(`@${c.devId} ${text}`); } catch {} };

    // ---------- チャンネル ----------
    const grid = $("chgrid");
    const cards = [0, 1, 2, 3].map((i) => {
      const n = i + 1;
      const card = el("div", { class: "chcard" });
      card.innerHTML = `<h3>ch${n} <span class="chips"><span class="flag" data-r="en">有効</span><span class="flag" data-r="enc" title="エンコーダ ENC${n} が読めているか">ENC</span></span></h3>
        <div class="seg">${MODES.map((m, k) => `<button data-m="${k}">${m}</button>`).join("")}</div>
        <div class="row"><label data-r="lab">目標</label><span class="grow"></span><label>±<input type="number" data-r="lim" step="any" style="width:64px"></label></div>
        <input type="range" data-r="slider" step="any">
        <div class="row"><input type="number" data-r="num" step="any" class="grow" value="0"><button class="pri" data-r="send">送信</button><button data-r="zero">0</button></div>
        <div class="row"><button data-r="en1">有効</button><button data-r="en0">無効</button><button data-r="stop">停止</button><button data-r="zpos" title="今の位置を0にする(Z)">位置を0に</button></div>
        <div class="live"><div>位置<b data-r="p">—</b>rad</div><div>速度<b data-r="v">—</b>rad/s</div><div>電流<b data-r="i">—</b>A</div><div>出力<b data-r="d">—</b>%</div></div>
        <div class="bar"><i data-r="bar"></i></div>`;
      grid.append(card);
      const r = (k) => card.querySelector(`[data-r="${k}"]`);
      const o = { card, r };
      const lim = () => Math.abs(+r("lim").value) || 1;
      const applyLim = () => { r("slider").min = -lim(); r("slider").max = lim(); };
      const sendTarget = (v) => {
        v = Math.max(-lim(), Math.min(lim(), v));
        r("num").value = v; r("slider").value = v;
        ch[i].target = v; ch[i].sent = true; state.active = true;
        cmd(`${n}M${fmtNum(v, ctx.conn().mode === "can" ? 6 : 12)}`);
      };
      o.setMode = (m, fromBoard) => {
        ch[i].mode = m; ch[i].modeAt = performance.now();
        card.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", +b.dataset.m === m));
        r("lab").textContent = `${MODES[m]}指令 [${MODE_UNIT[m]}]`;
        const base = m === 1 ? (state.vals[n].VL || RANGE0[1]) : RANGE0[m];
        r("lim").value = ch[i].range?.[m] ?? base; applyLim();
        r("slider").value = 0; r("num").value = 0;
        r("zpos").classList.toggle("hide", m !== 2);
        if (fromBoard) ch[i].target = m === 2 ? ch[i].p : 0;   // 基板は、位置モードに入ると目標を今の位置にする
      };
      card.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => {
        const m = +b.dataset.m;
        cmd(`${n}MC${m}`);            // 基板側で目標が 0(位置は今の位置)になる
        o.setMode(m);
        ch[i].target = m === 2 ? ch[i].p : 0; ch[i].sent = true; state.active = true;
        if (m === 2) { r("num").value = +ch[i].p.toFixed(3); r("slider").value = ch[i].p; r("lim").value = +Math.max(lim(), Math.abs(ch[i].p) + 1).toFixed(2); applyLim(); }
      }));
      r("lim").onchange = () => { (ch[i].range ||= {})[ch[i].mode] = +r("lim").value; applyLim(); };
      r("send").onclick = () => sendTarget(+r("num").value);
      r("num").onkeydown = (e) => { if (e.key === "Enter") sendTarget(+r("num").value); };
      r("zero").onclick = () => sendTarget(0);
      r("slider").oninput = (e) => { r("num").value = e.target.value; };
      r("slider").onchange = (e) => sendTarget(+e.target.value);
      r("en1").onclick = () => cmd(`${n}ME1`); r("en0").onclick = () => cmd(`${n}ME0`);
      r("stop").onclick = () => { cmd(`${n}S`); localStop(i); };
      r("zpos").onclick = () => { cmd(`${n}Z`); ch[i].off = 0; ch[i].last = null; ch[i].p = 0; ch[i].target = 0; r("num").value = 0; r("slider").value = 0; };
      o.setMode(0);
      return o;
    });
    function localStop(i) {
      ch[i].target = ch[i].mode === 2 ? ch[i].p : 0;
      cards[i].r("num").value = +ch[i].target.toFixed(3); cards[i].r("slider").value = ch[i].target;
    }
    $("stop").onclick = () => { cmd("S"); [0, 1, 2, 3].forEach(localStop); };
    $("x1").onclick = () => cmd("X1"); $("x0").onclick = () => cmd("X0");

    // 通信タイムアウト対策: 指令済みの ch の目標を送り続ける
    const keepTimer = setInterval(() => {
      if (!$("keep").checked || !tr.connected || !state.active) return;
      const c = ctx.conn();
      if (c.devId < 0) return;
      if (c.mode === "can") {
        const vals = ch.map((x) => (x.sent ? x.target : null));
        tr.sendCan(CAN.BDCMD_TARGET + c.devId, bdcmdTargetFrame(vals, ch.map((x) => SCALE[x.mode])));
      } else ch.forEach((x, i) => x.sent && quiet(`${i + 1}M${fmtNum(x.target, 8)}`));
    }, 200);

    // ---------- 受信 ----------
    const unwrap = (i, raw) => {   // CAN の位置は int16(±327.68 rad)で一周するので、差からつなぐ
      const x = ch[i];
      if (x.last != null) { const d = raw - x.last; if (d > 327.68) x.off -= 655.36; else if (d < -327.68) x.off += 655.36; }
      x.last = raw;
      return raw + x.off;
    };
    function row(t) {
      const r = { t };
      ch.forEach((x, i) => {
        const n = i + 1;
        r["p" + n] = x.p; r["v" + n] = x.v; r["i" + n] = x.i; r["d" + n] = x.d;
        r["tp" + n] = x.mode === 2 ? x.target : null; r["tv" + n] = x.mode === 1 ? x.target : null; r["td" + n] = x.mode === 0 ? x.target : null;
      });
      return r;
    }
    function showStatus(vb, fl) {
      $("vb").textContent = vb == null ? "—" : vb.toFixed(2) + " V";
      const names = flagNames(fl);
      $("flags").replaceChildren(...(names.length ? names : ["異常なし"]).map((n) => el("span", { class: "flag " + (names.length ? "bad" : "ok") }, n)));
      $("flaghelp").textContent = BD_FLAGS.filter((_, k) => fl & (1 << k)).map((f) => `${f[0]}: ${f[1]}`).join(" / ");
    }
    function setModeFromBoard(i, m) {
      // 自分でモードを切り替えた直後は、基板の状態がまだ古いので無視する(古い値で目標が 0 に戻るのを防ぐ)
      if (ch[i].mode !== m && m <= 2 && performance.now() - (ch[i].modeAt || 0) > 800) cards[i].setMode(m, true);
    }
    function showLive(i) {
      const x = ch[i], r = cards[i].r;
      r("p").textContent = x.p.toFixed(2); r("v").textContent = x.v.toFixed(2); r("i").textContent = x.i.toFixed(2); r("d").textContent = x.d.toFixed(1);
      const b = r("bar"), w = Math.min(100, Math.abs(x.d)) / 2;
      b.style.left = x.d >= 0 ? "50%" : 50 - w + "%"; b.style.width = w + "%";
    }
    function onMsg(m) {
      if (!m) return;
      if (m.type === "ch") {
        const i = m.ch - 1;
        Object.assign(ch[i], { p: unwrap(i, m.p), v: m.v, i: m.i, d: m.d });
        showLive(i);
        if (m.ch === 1) { charts.push(row((performance.now() - state.t0) / 1000)); ctx.markRx(); }
      } else if (m.type === "status") {
        showStatus(m.vb, m.fl);
        m.modes.forEach((mo, i) => setModeFromBoard(i, mo));
        m.en.forEach((e, i) => { ch[i].en = e; cards[i].r("en").className = "flag " + (e ? "ok" : ""); });
        m.enc.forEach((e, i) => { state.enc[i] = e; cards[i].r("enc").className = "flag " + (e ? "ok" : "bad"); });
      } else if (m.type === "uart-telem") {
        showStatus(m.vb, m.fl);
        m.chs.forEach((c, i) => {
          if (!c) return;
          if (c.m != null) setModeFromBoard(i, c.m);
          Object.assign(ch[i], { p: c.p ?? 0, v: c.v ?? 0, i: c.i ?? 0, d: c.d ?? 0 });
          showLive(i);
        });
        charts.push(row((performance.now() - state.t0) / 1000));
        ctx.markRx();
      } else if (m.type === "gain") gotGain(m.name, m.value);
      else if (m.type === "reset") {
        log.add(["初期化に失敗", "出荷状態に戻しました", "動作中のため拒否(停止してから)"][m.status], m.status === 1 ? "" : "err");
        if (m.status === 1) { setDirty(false); setTimeout(readAll, 200); }
      } else if (m.type === "saved") {
        log.add(["保存に失敗", "保存しました", "動作中のため保存を拒否(停止してから)"][m.status], m.status === 1 ? "" : "err");
        if (m.status === 1) setDirty(false);
      } else if (m.type === "log") log.add(m.text);
    }
    const detector = uartAutoDetector({ tr, ctx, log, onDetected: () => { ctx.setStop(stopCmds(ctx.conn())); readAll(); } });
    const offs = [
      tr.on("can", ({ id, data }) => {
        const c = ctx.conn();
        if (c.mode !== "can") return;
        if (c.devId < 0) {
          const base = id >= CAN.BDCMD_STATUS && id < CAN.BDCMD_STATUS + 8 ? id - CAN.BDCMD_STATUS : -1;
          if (base < 0) return;
          ctx.setDevId(base); log.add(`デバイスID自動検出: ${base}`); ctx.setStop(stopCmds(ctx.conn())); readAll();
        }
        const dev = ctx.conn().devId;
        $("idv").textContent = dev;
        onMsg(bdcmdDecodeCan(id, data, dev));
      }),
      tr.on("line", ({ text }) => {
        const c = ctx.conn();
        if (c.mode !== "uart") return;
        const p = splitPrefix(text);
        if (p.id != null) {
          if (c.devId < 0) { detector.observe(p.id); return; }
          if (p.id !== c.devId) return;
        }
        $("idv").textContent = c.devId;
        onMsg(bdcmdDecodeLine(p.text));
      }),
    ];

    // ---------- パラメータ ----------
    const setDirty = (d) => { state.dirty = d; $("gdirty").textContent = d ? "● 未保存の変更あり" : ""; $("gdirty").style.color = d ? "var(--bad)" : ""; };
    const io = { send: (t) => cmd(t), log: (t, c) => log.add(t, c), dirty: () => setDirty(true) };
    const vlen = () => (ctx.conn().mode === "can" ? 4 : 12);   // CAN は "P1VP" の後ろに 4 文字まで
    const bp = new ParamEditor($("bparams"), BOARD_PARAMS.map((p) => ({ key: "0" + p.n, label: p.l, unit: p.u, lo: p.lo, hi: p.hi, note: p.note, ph: "P0" + p.n, set: (v) => `P0${p.n}${fmtNum(v, vlen())}`, get: () => `?0${p.n}` })), io);
    const cp = new ParamEditor($("cparams"), CH_PARAMS.map((p) => ({ key: p.n, label: p.l, unit: p.u, lo: p.lo, hi: p.hi, note: p.note, ph: "P" + p.n, set: (v) => `P${state.sel}${p.n}${fmtNum(v, vlen())}`, get: () => `?${state.sel}${p.n}` })), io);
    function gotGain(name, v) {
      const c = +name[0], nm = name.slice(1);
      if (c === 0) return void bp.got(name, v);
      if (c >= 1 && c <= 4) {
        state.vals[c][nm] = v;
        if (c === state.sel) cp.got(nm, v);
        if (nm === "VL" && ch[c - 1].mode === 1 && !ch[c - 1].range?.[1]) { cards[c - 1].r("lim").value = v; cards[c - 1].r("slider").min = -v; cards[c - 1].r("slider").max = v; }
      }
    }
    function fillSel() { CH_PARAMS.forEach((p) => { const v = state.vals[state.sel][p.n]; cp.inputs[p.n].value = v == null ? "" : +v.toPrecision(5); }); }
    root.querySelectorAll("#chsel button").forEach((b) => (b.onclick = () => {
      state.sel = +b.dataset.c;
      root.querySelectorAll("#chsel button").forEach((x) => x.classList.toggle("on", x === b));
      fillSel();
      CH_PARAMS.forEach((p, i) => setTimeout(() => cmd(`?${state.sel}${p.n}`), i * 60));
    }));
    function readAll() {
      const list = [...BOARD_PARAMS.map((p) => `?0${p.n}`), ...CH_PARAMS.map((p) => `?${state.sel}${p.n}`)];
      // 各 ch のモードは基板の状態から分かる。速度の上限だけ、スライダーの範囲に使うので全 ch 分を読む
      for (let c = 1; c <= 4; c++) if (c !== state.sel) list.push(`?${c}VL`);
      list.forEach((t, i) => setTimeout(() => cmd(t), i * 60));
    }
    $("gall").onclick = readAll;
    $("gsave").onclick = () => { if (confirm("パラメータをフラッシュに保存します(数十msの間、基板の制御が止まります)。\nモーターを止めてから実行してください。続けますか?")) cmd("W"); };
    $("gfactory").onclick = () => { if (confirm("すべてのパラメータを出荷状態に戻し、保存済みの内容も消します。\n停止中に実行してください。続けますか?")) cmd("F"); };
    $("raw").onkeydown = (e) => { if (e.key === "Enter" && e.target.value) { cmd(e.target.value); e.target.value = ""; } };
    $("clog").onclick = () => log.clear();
    const onKey = (e) => { if (e.key === "Escape") $("stop").click(); };
    document.addEventListener("keydown", onKey);
    const onUnload = (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } };
    addEventListener("beforeunload", onUnload);

    return {
      async onConnect() {
        state.t0 = performance.now(); state.active = false;
        ch.forEach((x) => { x.sent = false; x.last = null; x.off = 0; });
        const c = ctx.conn();
        $("idv").textContent = c.devId < 0 ? "検出中…" : c.devId;
        if (c.mode === "uart") {
          if (c.devId >= 0) { await uartSelect(tr, c.devId); setTimeout(readAll, 400); } else detector.run();
        } else if (c.devId >= 0) setTimeout(readAll, 400);
      },
      onDisconnect() { state.active = false; },
      destroy() { clearInterval(keepTimer); offs.forEach((f) => f()); charts.destroy(); document.removeEventListener("keydown", onKey); removeEventListener("beforeunload", onUnload); },
    };
  },
};
