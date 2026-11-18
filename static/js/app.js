// 画面の枠組み: 基板の選択 → 接続 → 操作・設定 / 基板情報。
import { Transport } from "./transport.js";
import { BOARDS, byId } from "./boards/index.js";
import { el, esc, banner, localGet, localSet } from "./ui.js";

const tr = new Transport();
const $view = document.getElementById("view");
const $crumb = document.getElementById("crumb");
const LINK_NAME = { can: "CAN", uart: "UART / USB シリアル", udp: "Wi-Fi (UDP)" };
const LINK_SHORT = { can: "CAN", uart: "USB / UART", udp: "Wi-Fi" };

let cur = null;   // 今開いている基板の画面 {board, inst, ...}

// ======================================================================
// 基板の選択画面
// ======================================================================
function showSelect() {
  closeBoard();
  $crumb.innerHTML = "";
  const cards = BOARDS.map((b) => {
    const pic = b.photo ? el("div", { class: "pic" }, el("img", { src: b.photo.src, alt: b.name + " の基板", loading: "lazy", onerror: (e) => e.target.remove() }))
      : el("div", { class: "pic mon", html: `<svg width="150" height="110" viewBox="0 0 150 110" fill="none" stroke="currentColor" stroke-width="3" style="color:var(--acc)"><path d="M10 55h130" stroke-width="5"/><g><rect x="20" y="15" width="26" height="26" rx="4"/><rect x="62" y="68" width="26" height="26" rx="4"/><rect x="104" y="15" width="26" height="26" rx="4"/><path d="M33 41v14M75 68V55M117 41v14"/></g></svg>` });
    return el("button", { class: "bcard", onclick: () => go(b.id) }, [
      pic,
      el("div", { class: "body" }, [el("h3", {}, b.name), el("p", {}, b.tagline), el("div", { class: "tags" }, b.links.map((l) => el("span", { class: "tag" }, LINK_SHORT[l])))]),
    ]);
  });
  $view.replaceChildren(el("div", { class: "screen" }, el("div", { class: "wrap" }, [
    el("h2", {}, "どの基板を設定しますか?"),
    el("p", { class: "lead" }, "基板を選ぶと、接続 → 操作・パラメータ調整 → 保存まで、その基板専用の画面で行えます。基板の写真(KiCad から生成した 3D 画像)と、コネクタの説明も見られます。"),
    el("ol", { class: "steps", html: `<li><b>基板を選ぶ</b>下のカードから。分からなければ「全基板(CAN バス)」で、つながっている基板を調べられます。</li><li><b>つなぐ</b>CAN / USB / Wi-Fi のどれで基板につなぐかを選んで「接続」。</li><li><b>操作・設定</b>動かして確認し、ゲインなどを調整して、基板に保存します。</li>` }),
    el("div", { class: "cards" }, cards),
    el("div", { class: "help", html: `<h3>接続のしかた</h3><ul>
      <li><b>USB / UART だけなら、サーバ不要</b>です。Chrome か Edge でこのページを開き、「接続」でシリアルポートを選びます(Web Serial)。</li>
      <li><b>CAN と Wi-Fi(UDP)は、PC で <code>server.py</code> を動かす</b>必要があります(ブラウザからは CAN も UDP も直接使えないため)。<code>pip install aiohttp pyserial && python3 server.py</code> を実行して <code>http://localhost:8080</code> を開きます。</li>
      <li>ブラウザとサーバの通信は、同じ PC の中だけ(<code>127.0.0.1</code>)です。</li></ul>` }),
  ])));
}

// ======================================================================
// 基板の画面
// ======================================================================
function go(id) { location.hash = "#/" + id; }
window.addEventListener("hashchange", route);
document.getElementById("home").onclick = () => { location.hash = "#/"; };

function route() {
  const id = location.hash.replace(/^#\/?/, "");
  const b = byId(id);
  b ? showBoard(b) : showSelect();
}

function closeBoard() {
  if (!cur) return;
  const c = cur;
  cur = null;
  clearInterval(c.timer);
  c.offs.forEach((f) => f());
  if (tr.connected) tr.disconnect(true);   // 停止コマンドを送ってから切る
  c.inst?.destroy();
  for (const t of c.tabInst) t?.destroy?.();
}

function showBoard(b) {
  closeBoard();
  const saved = localGet("integral_conn_" + b.id, {});
  const S = { board: b, mode: b.links.includes(saved.mode) ? saved.mode : b.links[0], devId: b.devId ? saved.devId ?? -1 : 0, rx: 0, lastRx: 0, rxPrev: 0, since: 0, tabInst: [], offs: [], inst: null, tab: "main" };
  cur = S;
  $crumb.innerHTML = `<span class="mute">基板:</span> <b>${esc(b.name)}</b>`;

  // ---- 接続バー ----
  const bar = el("div", { id: "conn-bar" });
  bar.innerHTML = `
    <span class="seg" id="linkmode">${b.links.map((l) => `<button data-m="${l}">${LINK_NAME[l]}</button>`).join("")}</span>
    ${b.devId ? `<label>ID <select id="devid"><option value="-1">自動</option>${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<option>${i}</option>`).join("")}</select></label>` : ""}
    <span id="o-can"><label>I/F <select id="iface"></select></label></span>
    <span id="o-uart"><label id="routel">経路 <select id="route"><option value="server">サーバ経由</option><option value="web">ブラウザ直結(Web Serial)</option></select></label>
      <label id="portl">ポート <select id="port"></select></label><label>baud <input type="number" id="baud" value="${b.defaults.baud || 115200}" style="width:90px"></label></span>
    <span id="o-udp"><label>ホスト <input type="text" id="host" value="${esc(b.defaults.host || "")}" style="width:170px" placeholder="IP またはホスト名"></label><label>ポート <input type="number" id="udpport" value="${b.defaults.udpPort || 9100}" style="width:80px"></label></span>
    <button id="reload" title="ポート一覧を更新">↻</button>
    <label title="接続を切る/ブラウザを閉じるとき、基板へ停止コマンドを送ります"><input type="checkbox" id="stoponclose" checked>切断・終了時に停止を送る</label>
    <button class="pri" id="conn">接続</button>
    <span><span id="dot"></span> <span id="stat">未接続</span> <span id="rate" class="val mute"></span></span>
    <span id="hint" class="warn hide"></span>`;
  const q = (id) => bar.querySelector("#" + id);

  // ---- タブ ----
  const tabs = [{ id: "main", label: b.monitor ? "モニター" : "操作・設定" }, ...(b.mod.extraTabs || []), { id: "info", label: "基板情報(写真・コネクタ)" }];
  const tabBar = el("div", { class: "tabs" }, tabs.map((t) => el("button", { "data-t": t.id, onclick: () => setTab(t.id) }, t.label)));
  const panes = Object.fromEntries(tabs.map((t) => [t.id, el("div", { class: "tabpane hide" })]));
  $view.replaceChildren(bar, tabBar, ...tabs.map((t) => panes[t.id]));
  S.panes = panes;

  const ctx = {
    transport: tr, root: panes.main,
    conn: () => ({ mode: tr.connected ? tr.mode : S.mode, devId: S.devId }),
    setDevId(n) { S.devId = n; const s = q("devid"); if (s) s.value = String(n); },
    setStop(list) { tr.setOnClose(q("stoponclose").checked ? list : []); },
    markRx() { S.rx++; S.lastRx = performance.now(); },
  };
  S.inst = b.mod.create(ctx);

  tabs.slice(1).forEach((t) => {
    if (t.id === "info") renderInfo(panes.info, b);
    else S.tabInst.push(t.mount(panes[t.id], ctx));
  });
  function setTab(id) {
    S.tab = id;
    tabBar.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.t === id));
    for (const [k, p] of Object.entries(panes)) p.classList.toggle("hide", k !== id);
  }
  setTab("main");

  // ---- 接続方法の表示切替 ----
  function refresh() {
    const connected = tr.connected;
    bar.querySelectorAll("#linkmode button").forEach((x) => {
      const m = x.dataset.m;
      const ok = m === "uart" ? tr.backend || tr.webSerial : tr.backend;
      x.classList.toggle("on", m === S.mode);
      x.disabled = connected || !ok;
      x.title = ok ? "" : m === "uart" ? "このブラウザは Web Serial 非対応で、サーバ(server.py)にも未接続です" : `${LINK_NAME[m]} はサーバ(server.py)経由でのみ使えます`;
    });
    for (const m of ["can", "uart", "udp"]) q("o-" + m).classList.toggle("hide", m !== S.mode);
    const route = q("route"), web = tr.webSerial;
    route.querySelector('[value="web"]').disabled = !web;
    route.querySelector('[value="server"]').disabled = !tr.backend;
    if (!S.routeTouched) route.value = tr.backend ? "server" : "web";
    if (route.value === "server" && !tr.backend && web) route.value = "web";
    q("portl").classList.toggle("hide", route.value === "web");
    q("reload").classList.toggle("hide", !(tr.backend && S.mode !== "udp"));
    ["devid", "iface", "port", "baud", "host", "udpport", "route"].forEach((i) => { const e = q(i); if (e) e.disabled = connected; });
    q("conn").textContent = connected ? "切断" : "接続";
    q("dot").className = connected ? "ok" : "";
    if (!connected) q("stat").textContent = tr.backend || tr.webSerial ? "未接続" : "サーバ未接続 / このブラウザは Web Serial 非対応(Chrome / Edge を使用)";
    const hint = q("hint");
    hint.classList.toggle("hide", tr.backend);
    hint.textContent = "サーバ無しモード: USB シリアル(Web Serial)のみ。CAN と Wi-Fi は server.py を起動してください";
    document.getElementById("backend").textContent = tr.backend ? "● サーバ接続済み" : "○ サーバなし";
    const idel = q("devid"); if (idel) idel.value = String(S.devId);
  }
  bar.querySelectorAll("#linkmode button").forEach((x) => (x.onclick = () => { S.mode = x.dataset.m; localSet("integral_conn_" + b.id, { mode: S.mode, devId: S.devId }); fillPorts(); refresh(); S.inst.onModeChange?.(); }));
  q("route").onchange = () => { S.routeTouched = true; refresh(); };
  if (q("devid")) q("devid").onchange = () => { S.devId = +q("devid").value; localSet("integral_conn_" + b.id, { mode: S.mode, devId: S.devId }); };
  const fillPorts = async () => {
    if (!tr.backend) return;
    const r = await tr.loadPorts().catch(() => tr.ports);
    const fill = (id, list, def) => { const e = q(id), cur = e.value; e.innerHTML = (list.length ? list : def).map((x) => `<option>${esc(x)}</option>`).join(""); if (list.includes(cur)) e.value = cur; };
    fill("iface", r.can, ["can0"]); fill("port", r.serial, []);
  };
  q("reload").onclick = fillPorts;
  S.offs.push(tr.on("backend", () => { fillPorts(); refresh(); }));
  fillPorts(); refresh();

  // ---- 接続 / 切断 ----
  q("conn").onclick = async () => {
    if (tr.connected) return tr.disconnect(true);
    const via = S.mode === "uart" ? q("route").value : "server";
    if (S.mode === "uart" && via === "server" && !q("port").value) return banner("シリアルポートが見つかりません。USB をつないで ↻ を押してください");
    if (S.mode === "udp" && !q("host").value.trim()) return banner("ホスト名または IP アドレスを入力してください");
    const cfg = { mode: S.mode, via, iface: q("iface").value || "can0", port: q("port").value, baud: +q("baud").value, host: q("host").value.trim(), udpPort: +q("udpport").value };
    try {
      await tr.connect(cfg, q("stoponclose").checked ? b.mod.stopCmds({ mode: S.mode, devId: S.devId }) : []);
    } catch (e) { banner(String(e.message || e)); }
  };
  S.offs.push(tr.on("status", ({ connected }) => {
    S.rx = 0; S.lastRx = 0; S.rxPrev = 0; S.since = performance.now();
    refresh();
    if (connected) {
      q("stat").textContent = `接続中 (${LINK_SHORT[tr.mode]}${tr.via === "web" ? " / ブラウザ直結" : ""})`;
      localSet("integral_conn_" + b.id, { mode: S.mode, devId: S.devId });
      S.inst.onConnect?.();
    } else S.inst.onDisconnect?.();
  }));
  S.offs.push(tr.on("error", ({ text }) => banner(text)));

  // ---- 受信レートと、データが来ないときの案内 ----
  S.timer = setInterval(() => {
    if (!tr.connected) return;
    const now = performance.now();
    q("rate").textContent = S.rx ? `${S.rx - S.rxPrev} Hz` : "";
    S.rxPrev = S.rx;
    if (S.rx && now - S.lastRx > 1500) q("stat").textContent = "接続中 — データ途絶!";
    else if (S.rx) q("stat").textContent = `接続中 (${LINK_SHORT[tr.mode]}${tr.via === "web" ? " / ブラウザ直結" : ""})`;
    if (!S.rx && now - S.since > 4500 && !S.warned) { S.warned = true; banner(noDataHint(b, S.mode), "info"); }
    if (S.rx) S.warned = false;
  }, 1000);
}

function noDataHint(b, mode) {
  if (b.monitor) return "CAN のフレームが 1 つも届きません。①アダプタが can0 として up している(ビットレート 1 Mbps) ②CAN_H / CAN_L の配線と、両端の 120Ω 終端 ③基板の電源 を確認してください";
  if (mode === "can") return "基板からデータが届きません。①ID が違う可能性(「自動」で接続し直す) ②can0 が up している(1 Mbps)か ③CAN_H / CAN_L と終端、GND の共通 ④基板の電源 を確認してください";
  if (mode === "udp") return "基板からデータが届きません。①基板が同じ Wi-Fi につながっているか(LED で確認) ②ホスト名が引けなければ IP アドレスを入力 ③ファイアウォール(UDP)を確認してください";
  return "基板からデータが届きません。①配線(アダプタ TXD → 基板 RX、RXD → TX、GND 共通) ②baud ③基板の電源 ④ID が違う可能性(「自動」で接続し直す) を確認してください";
}

// ======================================================================
// 基板情報(写真 + 番号 + 説明)
// ======================================================================
const rich = (s) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

function renderInfo(root, b) {
  const wrap = el("div", { class: "info" });
  const cols = el("div", { class: "cols" });
  const left = el("div"), right = el("div");
  if (b.photo) {
    const ph = el("div", { class: "ph" }, el("img", { src: b.photo.src, alt: b.name + " の基板(上面)", width: b.photo.w, height: b.photo.h }));
    const pins = [];
    for (const p of b.photo.pins) for (const [x, y] of [[p.x, p.y], ...(p.more || [])]) {
      const pin = el("button", { class: "pin", "data-n": p.n, style: `left:${x}%;top:${y}%`, title: b.legend.find((l) => l.n === p.n)?.name || "" }, String(p.n));
      ph.append(pin); pins.push(pin);
    }
    left.append(el("figure", { class: "photo", style: "margin:0" }, [ph, el("figcaption", {}, "KiCad の基板データから生成した上面の 3D 画像です(実物の写真ではなく、一部の部品は形が簡略化されています)。番号を押すと右の説明が光ります。")]));
    const mark = (n, on) => { pins.forEach((x) => x.classList.toggle("act", on && +x.dataset.n === n)); wrap.querySelectorAll("tr[data-n]").forEach((r) => r.classList.toggle("act", on && +r.dataset.n === n)); };
    pins.forEach((p) => { p.onmouseenter = () => mark(+p.dataset.n, true); p.onmouseleave = () => mark(0, false); p.onclick = () => { const r = wrap.querySelector(`tr[data-n="${p.dataset.n}"]`); r?.scrollIntoView({ block: "center", behavior: "smooth" }); mark(+p.dataset.n, true); }; });
    right.append(el("h3", { style: "margin-top:0" }, "各部の説明"));
    right.append(el("table", { class: "legend", html: `<tbody>${b.legend.map((l) => `<tr data-n="${l.n}"><td class="n"><span>${l.n}</span></td><td><b>${esc(l.name)}</b><br>${rich(l.detail)}</td></tr>`).join("")}</tbody>` }));
    right.querySelectorAll("tr[data-n]").forEach((r) => { r.onmouseenter = () => mark(+r.dataset.n, true); r.onmouseleave = () => mark(0, false); });
  } else right.append(el("h3", { style: "margin-top:0" }, b.title));
  right.append(el("h3", {}, "仕様"), el("table", { class: "legend", html: `<tbody>${b.specs.map(([k, v]) => `<tr><th style="width:110px">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody>` }));
  right.append(el("h3", {}, "はじめ方"), el("ol", { html: b.steps.map((s) => `<li>${s}</li>`).join("") }));
  for (const n of b.notes) right.append(el("div", { class: "note " + (n.k === "w" ? "w" : ""), html: (n.k === "w" ? "⚠ " : "") + n.html }));
  right.append(el("p", { class: "small", html: `詳しくは <a href="${b.repo}" target="_blank" rel="noopener">${esc(b.repo.replace("https://github.com/", ""))}</a> の README と docs を参照してください。` }));
  if (!b.photo) cols.style.gridTemplateColumns = "minmax(0,760px)";
  cols.append(...(b.photo ? [left, right] : [right]));
  wrap.append(cols);
  root.append(wrap);
}

// ======================================================================
addEventListener("pagehide", () => tr.bestEffortStop());   // タブを閉じるとき(サーバ経由はサーバ側が停止を送る)
if (navigator.serial) navigator.serial.addEventListener("disconnect", () => { if (tr.via === "web") tr._webClose?.(); });
route();
