// main_board の「設定」画面。USB(UART)でつないだまま、基板の設定をすべて読み書きする(ビルドも設定ファイルも要らない)。
//   KL で基板から設定の一覧を読み、変えた項目だけ KS で送り、KA で反映して基板に保存する(基板のコマンドの仕様は docs/communication_spec.md)。
//   足回りの種類、アクチュエータの種類・ID・ch、操縦の入力などは、保存後に再起動すると反映される。
// 書き込みは USB / UART だけ(Wi-Fi の UDP からは、ネットワーク越しに書き換えられないよう基板が受け付けない。読むだけならできる)。
import { el, esc } from "../ui.js";
import { parseCfgLine, parseOpts } from "../protocol.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BIG = 1e5;   // これ以上の絶対値の可動範囲は「無制限」として表示する

export default function mount(root, ctx) {
  const tr = ctx.transport;
  let model = null;            // { info, globals: [cf], acts: [{id, actType, group, num, fields: [cf]}] }
  let building = null;
  let waiter = null;           // 応答待ち { resolve, errs }
  let loadTimer = 0;

  root.innerHTML = `<div class="info cfg"><div class="card">
    <h2>基板の設定(USB でつないだまま)</h2>
    <div class="row"><button class="pri" id="load">基板から読み込む (KL)</button><button class="pri" id="save">保存して反映 (KS / KA)</button>
      <button id="reboot">再起動 (KB)</button><button id="reset" title="保存した設定をすべて消して、設定ファイルの初期値に戻す">初期値に戻す (KR)</button>
      <span class="small mute" id="stat">未読み込み</span></div>
    <div class="small mute">変えた項目は黄色になります。「再起動後に反映」の項目(足回りの種類、アクチュエータの種類・ID・ch、操縦の入力、Wi-Fi の使用)は、保存したあと「再起動」を押すと使われます。
      書き込みは <b>USB(シリアル)でつないでいるときだけ</b>です(Wi-Fi 経由では読むだけ)。</div>
    <div id="rbnote" class="note w" style="display:none">保存した設定のうち、再起動後に反映されるものがあります。「再起動」を押してください。</div>
  </div><div id="form"></div></div>`;
  const $ = (id) => root.querySelector("#" + id);
  const mode = () => ctx.conn().mode;
  const stat = (t) => ($("stat").textContent = t);
  const send = (t) => (mode() === "udp" ? tr.sendUdp(t) : tr.sendLine(t));
  const canWrite = () => tr.connected && mode() !== "udp";

  // ---------- 受信 ----------
  function onLine(text) {
    const p = parseCfgLine(text);
    if (!p) return;
    if (p.type === "cs") { building = { info: p, globals: [], acts: [] }; clearTimeout(loadTimer); loadTimer = setTimeout(() => stat("読み込みが途中で止まりました。もう一度「読み込む」を押してください"), 10000); }
    else if (!building && p.type !== "c") return;
    else if (p.type === "ca") building.acts.push({ ...p, fields: [] });
    else if (p.type === "cf") {
      const dst = p.name.startsWith("g.") ? building.globals : building.acts.at(-1)?.fields;
      dst?.push(p);
      if (building.acts.length || building.globals.length) stat(`読み込み中… ${building.globals.length + building.acts.reduce((n, a) => n + a.fields.length, 0)} 項目`);
    } else if (p.type === "ce") { clearTimeout(loadTimer); model = building; building = null; render(); stat(`読み込みました(${model.globals.length + model.acts.reduce((n, a) => n + a.fields.length, 0)} 項目)`); }
    else if (p.type === "c" && waiter) { if (p.status === "err") waiter.errs++; if (p.status === "applied" || p.status === "rebooting" || p.status === "reset") waiter.resolve(p); }
  }
  const offs = [
    tr.on("line", ({ text }) => { if (mode() === "uart") onLine(text); }),
    tr.on("udp", ({ bytes }) => { if (mode() === "udp") new TextDecoder().decode(bytes).split(/\r?\n/).forEach((l) => l.trim() && onLine(l.trim())); }),
    tr.on("status", ({ connected }) => { if (connected) setTimeout(load, 2500); }),   // つないだら自動で読む(基板の起動を少し待つ)
  ];

  function load() {
    if (!tr.connected) return stat("未接続です(画面上部の「接続」を押してください)");
    building = null; stat("読み込み中…");
    send("KL");
  }

  // ---------- 表示 ----------
  const fmtDeg = (r) => (Number.isFinite(r) ? `(${((r * 180) / Math.PI).toFixed(1)}°)` : "");
  function field(f) {
    const unl = /\.(lo|hi)$/.test(f.name) && Math.abs(f.v) >= BIG;
    let inp;
    if (f.opts) inp = `<select data-n="${f.name}">${parseOpts(f.opts).map(([v, t]) => `<option value="${v}" ${v === f.v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
    else if (f.t === "b") inp = `<input type="checkbox" data-n="${f.name}" ${f.v ? "checked" : ""}>`;
    else inp = `<input type="number" step="any" data-n="${f.name}" value="${unl ? "" : f.v}" ${/\.(lo|hi)$/.test(f.name) ? 'placeholder="無制限"' : ""} style="width:120px">`;
    let ex = "";
    if (f.unit === "rad") ex += `<span class="small mute" data-deg></span>`;
    if (/\.encZeroRad$/.test(f.name)) ex += `<button data-zero="${f.name.split(".")[0]}">今の位置を 0 にする</button>`;
    return `<div class="row" data-row="${f.name}"><label style="flex:1 1 260px">${esc(f.label)}${f.rb ? ' <span class="small mute">(要再起動)</span>' : ""}</label>${inp}<span class="small mute" style="min-width:50px">${esc(f.unit)}</span>${ex}</div>`;
  }
  const card = (t, b) => `<section class="card"><h2>${t}</h2>${b}</section>`;

  function render() {
    const m = model;
    $("rbnote").style.display = m.info.reboot ? "" : "none";
    const groups = {};
    m.globals.forEach((f) => (groups[f.group] ||= []).push(f));
    let h = Object.entries(groups).map(([g, fs]) => card(esc(g), fs.map(field).join(""))).join("");
    const used = m.acts.filter((a) => a.actType !== "NONE"), unused = m.acts.filter((a) => a.actType === "NONE");
    h += used.map((a) => card(`${esc(a.group)} ${a.num} <span class="small mute">${a.actType}</span>`, a.fields.map(field).join(""))).join("");
    if (unused.length) h += card("使っていないアクチュエータ <span class=\"small mute\">種類を選んで保存・再起動すると使えます</span>", unused.map((a) => a.fields.map(field).join("").replace(/<label[^>]*>[^<]*/, `<label style="flex:1 1 260px">${esc(a.group)} ${a.num}`)).join(""));
    $("form").innerHTML = h;
    root.querySelectorAll("[data-row]").forEach((row) => {
      const el_ = row.querySelector("input,select");
      const upd = () => { const f = findField(row.dataset.row), v = val(el_, f); row.style.background = Math.abs(v - f.v) < 1e-6 ? "" : "rgba(255, 200, 0, .18)"; const dg = row.querySelector("[data-deg]"); if (dg) dg.textContent = el_.value === "" ? "" : fmtDeg(v); };
      el_.oninput = el_.onchange = upd; upd();
    });
    root.querySelectorAll("[data-zero]").forEach((b) => (b.onclick = async () => {
      if (!canWrite()) return stat("USB(シリアル)でつないでいるときだけ使えます");
      if (!confirm("関節がいま「角度 0」の姿勢ですか?\nいまのエンコーダの値を 0 点として基板に保存します。")) return;
      send(`KZ ${b.dataset.zero}`); stat("0 点を登録しました"); setTimeout(load, 800);
    }));
  }
  const allFields = () => [...model.globals, ...model.acts.flatMap((a) => a.fields)];
  const findField = (name) => allFields().find((f) => f.name === name);
  const val = (e, f) => (e.type === "checkbox" ? (e.checked ? 1 : 0) : e.tagName === "SELECT" ? +e.value : e.value === "" ? (/\.lo$/.test(f.name) ? -1e6 : 1e6) : +e.value);

  // ---------- 操作 ----------
  async function save() {
    if (!model) return stat("先に「基板から読み込む」を押してください");
    if (!canWrite()) return stat("書き込みは USB(シリアル)でつないでいるときだけです");
    const changes = [];
    root.querySelectorAll("[data-row]").forEach((row) => {
      const f = findField(row.dataset.row), v = val(row.querySelector("input,select"), f);
      if (Number.isFinite(v) && Math.abs(v - f.v) >= 1e-6) changes.push([f.name, v]);
    });
    if (!changes.length) return stat("変更はありません");
    changes.sort((a, b) => (/\.type$/.test(a[0]) ? 0 : 1) - (/\.type$/.test(b[0]) ? 0 : 1));   // 種類を先に(種類で、使える項目が決まる)
    waiter = { errs: 0, resolve: null };
    const done = new Promise((r) => (waiter.resolve = r));
    stat(`送信中… ${changes.length} 項目`);
    for (const [n, v] of changes) { send(`KS ${n} ${v}`); await sleep(25); }
    send("KA");
    const r = await Promise.race([done, sleep(4000).then(() => null)]);
    const errs = waiter.errs; waiter = null;
    if (!r) return stat("基板から応答がありません(USB の接続を確認してください)");
    stat(`保存して反映しました(${changes.length} 項目${errs ? `、うち ${errs} 項目は基板が受け付けませんでした` : ""}${/reboot=1/.test(r.rest) ? "。再起動で反映される項目があります" : ""})`);
    setTimeout(load, 600);
  }
  $("load").onclick = load;
  $("save").onclick = save;
  $("reboot").onclick = async () => {
    if (!canWrite()) return stat("USB(シリアル)でつないでいるときだけです");
    if (!confirm("基板を再起動します(足回りは止まります)。")) return;
    send("KB"); stat("再起動中…"); setTimeout(() => { send("T 1"); load(); }, 4000);
  };
  $("reset").onclick = () => {
    if (!canWrite()) return stat("USB(シリアル)でつないでいるときだけです");
    if (!confirm("保存した設定をすべて消して、設定ファイルの初期値に戻します。基板を再起動します。")) return;
    send("KR"); stat("再起動中…"); setTimeout(() => { send("T 1"); load(); }, 4000);
  };

  return { destroy() { offs.forEach((f) => f()); clearTimeout(loadTimer); } };
}
