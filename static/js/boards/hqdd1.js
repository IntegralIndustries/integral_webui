// HQDD1(QDD アクチュエータ、FOC)。hqdd1 リポジトリの webui を、共通の枠組みに載せ替えたもの。
import { CAN, hqddDecodeCan, hqddDecodeLine, splitPrefix, toBytes } from "../protocol.js";
import { ChartBoard } from "../chart.js";
import { LogPanel, ParamEditor } from "../ui.js";
import { uartSelect, uartAutoDetector } from "./common.js";
import { noFlash } from "./flasher.js";

const SERIES = {
  v: ["実速度", "rad/s", 0], tgt_v: ["目標(速度)", "rad/s", 1, 1],
  sa: ["実角度", "rad", 2], tgt_a: ["目標(位置)", "rad", 1, 1],
  iq: ["Iq", "A", 3], id: ["Id", "A", 4], tgt_i: ["目標(トルク→Iq換算)", "A", 1, 1],
  vq: ["Vq", "V", 5], trq: ["トルク", "Nm", 6], tgt: ["目標(生値)", "", 7, 1],
};
const FOLLOW = { 0: ["iq", "tgt_i"], 1: ["v", "tgt_v"], 2: ["sa", "tgt_a"], null: ["v", "tgt"] };
const PRESETS = {
  follow: { label: "モード連動(実値＋目標)", follow: true },
  v: { label: "速度", keys: ["v", "tgt_v"], title: "速度" },
  a: { label: "位置", keys: ["sa", "tgt_a"], title: "位置" },
  i: { label: "電流 Iq/Id", keys: ["iq", "id", "tgt_i"], title: "電流" },
  vt: { label: "Vq / トルク", keys: ["vq", "trq"], title: "Vq / トルク" },
};
const MODE_NAME = { 0: "トルク", 1: "速度", 2: "位置" };
const UNITS = { 0: ["トルク指令", "出力換算電流 (A×減速比)"], 1: ["速度指令", "rad/s (出力軸)"], 2: ["位置指令", "rad (出力軸)"] };
const DEF_LIM = { 0: 5, 1: 5, 2: 12.57 };

// 設定は pre+値(例 "MVP0.02")、読み出しは "?"+q。範囲は基板側でも検証される。
const PID = [
  { l: "速度 P", pre: "MVP", q: "VP" }, { l: "速度 I", pre: "MVI", q: "VI" }, { l: "速度 D", pre: "MVD", q: "VD" },
  { l: "速度 LPF", pre: "MVF", q: "VF", u: "s" }, { l: "位置 P", pre: "MAP", q: "AP" },
  { l: "電流 P", pre: "MQP", q: "QP", note: "q軸・d軸共通" }, { l: "電流 I", pre: "MQI", q: "QI", note: "q軸・d軸共通" },
];
const LIMITS = [
  { l: "電流上限", pre: "PIL", q: "IL", u: "A", lo: 0.05, hi: 5, note: "モーター電流の上限(トルク指令・速度PIDの出力を制限)" },
  { l: "速度上限", pre: "PVL", q: "VL", u: "rad/s", lo: 1, hi: 300, note: "モーター軸基準。出力軸では" },
  { l: "電圧上限", pre: "PUL", q: "UL", u: "V", lo: 0.5, hi: 17, note: "電流PIDの出力上限。電源電圧を超えない" },
  { l: "電源電圧", pre: "PSV", q: "SV", u: "V", lo: 5, hi: 17, note: "LiPoバッテリーに合わせる(測定回路が無いので手動)。2セル(2S)=8 / 3セル(3S)=12" },
  { l: "減速比", pre: "PGR", q: "GR", lo: 0.1, hi: 1000, note: "表示・指令の換算のみ。変更後は位置の意味が変わる" },
  { l: "整列電圧", pre: "PAV", q: "AV", u: "V", lo: 0.5, hi: 12, note: "起動時の電気角合わせ。次回起動から有効" },
];
const toParam = (p) => ({ key: p.q, label: p.l, unit: p.u, lo: p.lo, hi: p.hi, note: p.note, ph: p.pre, set: (v) => p.pre + v, get: () => "?" + p.q });

const TEMPLATE = `
<main class="grid">
<aside>
  <div class="card">
    <button class="big-stop" id="stop">■ 停止 (S)</button>
    <button id="stopall" class="hide" style="margin-top:8px;width:100%">■ 全台停止 (UARTバス全体 @*)</button>
  </div>
  <div class="card">
    <h2>運転</h2>
    <div class="row"><label>モータ</label><div class="seg grow"><button id="en1">Enable</button><button id="en0">Disable</button></div></div>
    <div class="row"><label>モード</label></div>
    <div class="seg" id="modes"><button data-c="0">トルク</button><button data-c="1">速度</button><button data-c="2">位置</button></div>
    <div class="row"><label id="tlabel">目標</label><span class="grow"></span><span class="val mute" id="tunit"></span></div>
    <input type="range" id="slider" step="any">
    <div class="row"><input type="number" id="tnum" step="any" class="grow" value="0"><button class="pri" id="tsend">送信</button><button id="tzero">0</button></div>
    <div class="row"><label>範囲 ±<input type="number" id="tlim" step="any" value="5" style="width:70px"></label><label><input type="checkbox" id="live">スライダーで即送信</label></div>
    <div id="poscard" class="hide">
      <div class="row"><button data-j="-0.5">−0.5</button><button data-j="-0.1">−0.1</button><button data-j="0.1">+0.1</button><button data-j="0.5">+0.5</button><span class="mute small">rad 現在の目標から</span></div>
      <div class="row"><button id="syncpos" title="スライダー/入力欄を現在位置に合わせる(送信はしない)">現在位置に合わせる</button><button id="zeropos" title="今の位置を0 radとして再定義(Zコマンド)">現在位置を0にリセット</button></div>
    </div>
    <div class="warn" id="tnote"></div>
  </div>
  <div class="card"><h2>PIDゲイン (速度・位置・電流)</h2><div id="gains"></div><div class="warn" id="gnote"></div></div>
  <div class="card lim">
    <h2>制限・システム設定 <span style="font-weight:400">(PIDとは別の値)</span></h2>
    <div id="limits"></div>
    <div class="row"><label>LiPo電源電圧</label>
      <button data-sv="8" title="LiPoバッテリー2セル直列: 公称7.4V、満充電8.4V">2セル(2S) 8V</button>
      <button data-sv="12" title="LiPoバッテリー3セル直列: 公称11.1V、満充電12.6V">3セル(3S) 12V</button></div>
    <div class="warn" id="lnote"></div>
  </div>
  <div class="card">
    <h2>設定の保存・初期化 (PID・制限・減速比 すべて)</h2>
    <div class="row"><button id="gall" title="基板の現在値を全項目に読み込む">全て読込</button>
      <button id="gsave" class="pri" title="基板のフラッシュに保存。電源を切っても残る(プログラムを書き込み直すとコードの値に戻る)。停止中に押す">フラッシュに保存</button>
      <span id="gdirty" class="val small"></span></div>
    <div class="row"><button id="gfactory" class="danger" title="コードに書かれた初期値に戻し、保存内容も消す">出荷状態に戻す</button><span class="mute small">基板に書き込んだコードの値</span></div>
  </div>
  <div class="card">
    <h2>生コマンド / ログ</h2>
    <div class="row"><input type="text" id="raw" placeholder="例: MC1  MVP0.02  PIL1.5  ME1  (Enterで送信)"></div>
    <div id="logbox"></div>
    <div class="row"><button id="cap" title="UART接続時のみ。1kHz×600点を基板が溜めて送る">高速キャプチャ(L)</button><button id="clog">ログ消去</button></div>
  </div>
</aside>
<section id="chartarea"></section>
</main>`;

function stopCmds(conn) {
  if (conn.devId < 0) return [];
  return conn.mode === "can" ? [{ kind: "can", id: CAN.HQDD_CMD + conn.devId, data: [0x53] }] : [{ kind: "uart", text: `@${conn.devId} S` }];
}

export default {
  id: "hqdd1",
  stopCmds,
  extraTabs: [{ id: "flash", label: "ファームウェア書き込み", mount: noFlash("<b>HQDD1 は、この画面からは書き込めません。</b>基板に USB コネクタがなく、ブートローダの UART のピンも使っていないため、書き込みは <b>ST-Link(J2 の SWDIO / SWCLK / GND)</b>で行います。手順は hqdd1 リポジトリの README(<code>pio run -t upload</code>。新しい基板では、先にオプションバイトの修正が必要)にあります。") }],

  create(ctx) {
    const root = ctx.root;
    root.innerHTML = TEMPLATE;
    const $ = (id) => root.querySelector("#" + id);
    const tr = ctx.transport;
    const log = new LogPanel($("logbox"));
    const state = { mode: null, target: 0, lastSa: 0, gear: null, dirty: false, buf0: performance.now(), autoRead: false };

    const charts = new ChartBoard($("chartarea"), {
      series: SERIES, presets: PRESETS, storage: "integral_hqdd1_charts",
      follow: () => FOLLOW[state.mode] || FOLLOW[null],
      initial: [{ follow: true }], csvKeys: ["v", "tgt", "sa", "iq", "id", "vq", "trq"], csvName: "hqdd1",
      note: "CANは周期20ms、UARTは200msで更新されます。",
    });

    // ---------- 送信 ----------
    function track(text) {
      let m;
      if ((m = /^M([-+]?\d+(?:\.\d*)?)$/.exec(text))) state.target = +m[1];
      if ((m = /^MC(\d)$/.exec(text))) {   // 基板はモード切替時に目標を「位置=現在位置 / それ以外=0」にする
        state.mode = +m[1];
        state.target = state.mode === 2 ? state.lastSa : 0;
      }
      if (text === "Z") { state.lastSa = 0; if (state.mode === 2) state.target = 0; }
      if (text === "S") { state.target = 0; state.mode = 1; }
    }
    function cmd(text, all = false) {
      const c = ctx.conn();
      if (!tr.connected) return log.err("未接続です");
      try {
        if (c.mode === "can") {
          if (text.length > 8) return log.err(`CANは8文字まで: ${text}`);
          if (c.devId < 0) return log.err("デバイスID検出待ち(テレメトリ受信後に送信できます)");
          tr.sendCan(CAN.HQDD_CMD + c.devId, toBytes(text));
        } else {
          if (c.devId < 0 && !all) return log.err("IDを検出中です。少し待ってください");
          tr.sendLine((all ? "@* " : `@${c.devId} `) + text);
        }
      } catch (e) { return log.err(String(e.message || e)); }
      track(text);
      log.tx((all ? "[全台] " : "") + text);
    }

    // ---------- 受信 ----------
    function derive(m) {
      const t = m.tgt ?? state.target;
      m.tgt = t;
      m.tgt_v = state.mode === 1 ? t : null;
      m.tgt_a = state.mode === 2 ? t : null;
      m.tgt_i = state.mode === 0 && state.gear ? t / state.gear : null;
    }
    function onMsg(m) {
      if (!m) return;
      if (m.type === "telem") {
        m.t = (performance.now() - state.buf0) / 1000;
        if (m.sa != null) state.lastSa = m.sa;
        if (m.tgt != null && ctx.conn().mode === "uart") state.target = m.tgt;   // UART は基板の目標値が来る
        if (ctx.conn().mode === "can") m.tgt = state.target;
        derive(m);
        charts.push(m);
        ctx.markRx();
        if (state.autoRead) { state.autoRead = false; readAll(); }
      } else if (m.type === "gain") gotGain(m.name, m.value);
      else if (m.type === "reset") {
        log.add(["初期化に失敗", "出荷状態に戻しました", "回転中のため拒否(停止してから)"][m.status], m.status === 1 ? "" : "err");
        if (m.status === 1) { setDirty(false); setTimeout(readAll, 200); }
      } else if (m.type === "saved") {
        log.add(["保存に失敗", "保存しました", "回転中のため保存を拒否(停止してから)"][m.status], m.status === 1 ? "" : "err");
        if (m.status === 1) setDirty(false);
      } else if (m.type === "log") log.add(m.text);
    }
    const offs = [
      tr.on("can", ({ id, data }) => {
        const c = ctx.conn();
        if (c.mode !== "can") return;
        if (c.devId < 0) {   // 自動検出: 最初に見えたノードを採用
          if (id >= CAN.HQDD_TELEM && id < CAN.HQDD_TELEM + 8 && data.length >= 8) {
            ctx.setDevId(id - CAN.HQDD_TELEM);
            log.add(`デバイスID自動検出: ${id - CAN.HQDD_TELEM}`);
            ctx.setStop(stopCmds(ctx.conn()));
          } else return;
        }
        onMsg(hqddDecodeCan(id, data, ctx.conn().devId));
      }),
      tr.on("line", ({ text }) => {
        const c = ctx.conn();
        if (c.mode !== "uart") return;
        const p = splitPrefix(text);   // "#<id> ..." は対象ID以外を捨てる(接頭辞なしは従来形式として通す)
        if (p.id != null) {
          if (c.devId < 0) { detector.observe(p.id); return; }
          if (p.id !== c.devId) return;
        }
        onMsg(hqddDecodeLine(p.text));
      }),
    ];

    // ---------- 接続 ----------
    const detector = uartAutoDetector({ tr, ctx, log, onDetected: () => { ctx.setStop(stopCmds(ctx.conn())); state.autoRead = true; } });
    async function onConnect() {
      state.buf0 = performance.now();
      state.autoRead = true;
      const c = ctx.conn();
      $("stopall").classList.toggle("hide", c.mode !== "uart");
      if (c.mode === "uart") {
        if (c.devId >= 0) await uartSelect(tr, c.devId);
        else { state.autoRead = false; detector.run(); }
      }   // CAN の自動検出は、最初のテレメトリで ID が決まった時に読み出す
      notes();
    }

    // ---------- 運転 ----------
    function setMode(c) {
      state.mode = c;
      root.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("on", +b.dataset.c === c));
      $("tlabel").textContent = UNITS[c][0]; $("tunit").textContent = UNITS[c][1];
      $("tlim").value = DEF_LIM[c]; applyLim();
      $("poscard").classList.toggle("hide", c !== 2);
      $("tnote").textContent = c === 2 ? "位置モード: 入った時の目標は現在位置です。送信するまで動きません。" : "";
      charts.charts.forEach((ch) => ch.cfg.follow && ch.refreshChips());
    }
    const applyLim = () => { const l = Math.abs(+$("tlim").value) || 1; $("slider").min = -l; $("slider").max = l; };
    const clampT = (v) => { const l = Math.abs(+$("tlim").value); return Math.max(-l, Math.min(l, v)); };
    function sendTarget(v) { v = clampT(v); $("tnum").value = v; $("slider").value = v; cmd("M" + +v.toFixed(3)); }
    function syncPos() {
      const a = +state.lastSa.toFixed(3), l = Math.max(Math.abs(+$("tlim").value), Math.abs(a) + 1);
      $("tlim").value = +l.toFixed(2); applyLim(); $("tnum").value = a; $("slider").value = a;
    }
    root.querySelectorAll("#modes button").forEach((b) => (b.onclick = () => {
      // MC だけ送る。基板側が切替と同時に目標を「位置=現在位置 / その他=0」にするので、直後に目標値は送らない
      const c = +b.dataset.c; cmd("MC" + c); setMode(c);
      if (c === 2) syncPos(); else { $("tnum").value = 0; $("slider").value = 0; }
    }));
    $("syncpos").onclick = syncPos;
    $("zeropos").onclick = () => { cmd("Z"); $("tnum").value = 0; $("slider").value = 0; log.add("現在位置を0にリセット"); };
    root.querySelectorAll("#poscard [data-j]").forEach((b) => (b.onclick = () => sendTarget((+$("tnum").value || 0) + +b.dataset.j)));
    const doStop = () => { cmd("S"); $("tnum").value = 0; $("slider").value = 0; setMode(1); };
    $("stopall").onclick = () => { cmd("S", true); $("tnum").value = 0; $("slider").value = 0; setMode(1); };
    $("stop").onclick = doStop;
    $("en1").onclick = () => cmd("ME1"); $("en0").onclick = () => cmd("ME0");
    $("tsend").onclick = () => sendTarget(+$("tnum").value);
    $("tnum").onkeydown = (e) => { if (e.key === "Enter") sendTarget(+$("tnum").value); };
    $("tzero").onclick = () => sendTarget(0);
    $("tlim").onchange = applyLim;
    let lastLive = 0;
    $("slider").oninput = (e) => {
      $("tnum").value = e.target.value;
      if ($("live").checked && performance.now() - lastLive > 60) { lastLive = performance.now(); sendTarget(+e.target.value); }
    };
    $("slider").onchange = (e) => sendTarget(+e.target.value);
    const onKey = (e) => { if (e.key === "Escape") doStop(); };
    document.addEventListener("keydown", onKey);

    // ---------- ゲイン ----------
    const setDirty = (d) => { state.dirty = d; $("gdirty").textContent = d ? "● 未保存の変更あり" : ""; $("gdirty").style.color = d ? "var(--bad)" : ""; };
    const io = { send: (t) => cmd(t), log: (t, c) => log.add(t, c), dirty: () => setDirty(true) };
    const gains = new ParamEditor($("gains"), PID.map(toParam), io);
    const limits = new ParamEditor($("limits"), LIMITS.map(toParam), io);
    root.querySelectorAll("[data-sv]").forEach((b) => (b.onclick = () => { limits.inputs.SV.value = b.dataset.sv; cmd("PSV" + b.dataset.sv); setDirty(true); setTimeout(() => cmd("?SV"), 120); }));
    function hints() {
      const vl = limits.value("VL");
      limits.hint("VL", vl && state.gear ? ` ${(vl / state.gear).toFixed(2)} rad/s` : "");
    }
    function gotGain(name, v) {
      if (name === "MC") { const c = Math.round(v); if (c !== state.mode) { setMode(c); if (c === 2) syncPos(); } return; }
      if (name === "GR") state.gear = v;
      gains.got(name, v) || limits.got(name, v);
      hints();
    }
    function readAll() { ["?MC"].concat([...PID, ...LIMITS].map((p) => "?" + p.q)).forEach((c, i) => setTimeout(() => cmd(c), i * 60)); }
    $("gall").onclick = readAll;
    $("gfactory").onclick = () => {
      if (confirm("すべてのパラメータ(PIDゲイン・制限値・電源電圧・減速比)を出荷状態に戻し、保存済みの内容も消します。\n停止中に実行してください。続けますか?")) cmd("F");
    };
    $("gsave").onclick = () => {
      if (confirm("現在のゲイン・減速比をフラッシュに保存します(数十msの間、基板の制御が止まります)。\n停止中に実行してください。続けますか?")) cmd("W");
    };
    const onUnload = (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } };
    addEventListener("beforeunload", onUnload);
    $("raw").onkeydown = (e) => { if (e.key === "Enter" && e.target.value) { cmd(e.target.value); e.target.value = ""; } };
    $("clog").onclick = () => log.clear();
    function notes() {
      const can = ctx.conn().mode === "can";
      $("gnote").textContent = can ? "CANは1コマンド8文字まで(例 MVP0.015)。「設定」は即反映、電源を切っても残すには「フラッシュに保存」。" : "「設定」は即反映、電源を切っても残すには「フラッシュに保存」。コマンドには宛先ID(@id)が付きます。";
      $("lnote").textContent = can ? "CANは1コマンド8文字まで。" : "";
      $("cap").disabled = can;
    }

    // ---------- 高速キャプチャ(UART) ----------
    let cap = null, capChart = null;
    offs.push(tr.on("line", ({ text }) => {   // キャプチャの行には "#id" が付かない
      if (ctx.conn().mode !== "uart") return;
      if (text === "CAPBEGIN") { cap = []; return; }
      if (text === "CAPEND") { showCapture(cap || []); cap = null; return; }
      if (cap) { const r = text.split(",").map(Number); if (r.length >= 5 && r.every(isFinite)) cap.push(r); }
    }));
    function showCapture(rows) {
      log.add(`キャプチャ受信 ${rows.length}点`);
      if (!rows.length) return;
      if (capChart) { capChart.box.remove(); charts.charts.splice(charts.charts.indexOf(capChart), 1); }
      // 列: t[us], v, Iq, Vq, sa (v,saはモータ軸基準の生値)
      const data = rows.map((r) => ({ t: r[0] / 1e6, v: r[1], iq: r[2], vq: r[3], sa: r[4] }));
      capChart = charts.add({ keys: ["v", "iq", "vq"], title: "キャプチャ (1kHz, モータ軸の生値)", auto: true }, data);
      capChart.refreshChips();
    }
    $("cap").onclick = () => { cmd("L"); log.add("キャプチャ中(約0.6秒、その間テレメトリ停止)…"); };

    setMode(1);
    notes();
    return {
      onConnect, onDisconnect() {},
      destroy() { offs.forEach((f) => f()); charts.destroy(); document.removeEventListener("keydown", onKey); removeEventListener("beforeunload", onUnload); },
      onModeChange: notes,
    };
  },
};
