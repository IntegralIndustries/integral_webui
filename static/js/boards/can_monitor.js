// 全基板の CAN バスモニター。どの基板が何番でバスにいるかを、流れているフレームから調べる(受信だけ。送るのは非常停止と手入力のみ)。
import { classifyCan, bdcmdDecodeCan, flagNames, hex, toBytes, u16, CAN } from "../protocol.js";
import { LogPanel, el, esc } from "../ui.js";

const NAMES = { hqdd1: "HQDD1", bdcmd_x1: "BDCMD_X1", lds01_esp32: "LDS01_ESP32", main_board: "main_board" };
const TEMPLATE = `
<main class="grid">
<aside>
  <div class="card">
    <button class="big-stop" id="es1">■ 全基板に非常停止 (0x001)</button>
    <div class="row"><button id="es0" class="grow">解除 (0x001 = 0)</button></div>
    <div class="small mute">BDCMD_X1 は受信すると全chを 0 にします。HQDD1 は 0x001 を受け取らないので、HQDD1 の画面の停止ボタンを使ってください。main_board がつながっているときは、main_board が非常停止の間 100ms ごとに 1 を送り続けます。</div>
  </div>
  <div class="card">
    <h2>バスの状態</h2>
    <dl class="kv"><dt>フレーム数</dt><dd id="fps" class="val">—</dd><dt>バス使用率(目安)</dt><dd id="load" class="val">—</dd></dl>
    <div class="small mute">1 フレームを約 120 ビットとして、1 Mbps に対する割合を計算した目安です。</div>
  </div>
  <div class="card"><h2>フレームを送る(上級者向け)</h2>
    <div class="row"><input type="text" id="sid" placeholder="ID(16進) 例 121" style="width:110px"><input type="text" id="sdat" placeholder="データ(16進) 例 53" class="grow"><button id="sgo">送信</button></div>
    <div class="row"><label><input type="checkbox" id="sasc">データを文字列として送る(例 <code>S</code>、<code>1MC1</code>)</label></div></div>
  <div class="card"><h2>ログ</h2><div id="logbox"></div></div>
</aside>
<section>
  <div class="card"><h2>バスにいる基板</h2>
    <table class="t" id="nodes"><thead><tr><th>基板</th><th>ID</th><th>状態</th><th>フレーム/秒</th><th>最後の受信</th></tr></thead><tbody></tbody></table>
    <div class="small mute" id="nonode" style="margin-top:6px">フレームを待っています。基板に電源を入れ、CAN をつないでください(終端 120Ω は両端に 1 つずつ)。</div></div>
  <div class="card"><div class="row"><h2 style="margin:0" class="grow">流れているフレーム</h2><label><input type="checkbox" id="pause">一時停止</label><label>絞り込み <select id="flt"><option value="">すべて</option><option value="hqdd1">HQDD1</option><option value="bdcmd_x1">BDCMD_X1</option><option value="lds01_esp32">LDS01_ESP32</option><option value="main_board">main_board / 非常停止</option></select></label></div>
    <div class="log" id="frames" style="height:340px"></div></div>
</section>
</main>`;

export default {
  id: "can_monitor",
  stopCmds: () => [],
  create(ctx) {
    const root = ctx.root;
    root.innerHTML = TEMPLATE;
    const $ = (id) => root.querySelector("#" + id);
    const tr = ctx.transport, log = new LogPanel($("logbox"), 90);
    const nodes = new Map(), counts = { n: 0, last: 0 };
    let t0 = performance.now(), frames = 0;

    function note(c, id, data) {
      const key = `${c.board}#${c.dev ?? "-"}`;
      let n = nodes.get(key);
      if (!n) nodes.set(key, (n = { board: c.board, dev: c.dev, n: 0, rate: 0, last: 0, info: "", present: false }));
      n.n++; n.last = performance.now();
      if (c.from || c.board === "lds01_esp32" || id === CAN.HEARTBEAT) n.present = true;   // 基板自身が送ったフレーム(コマンドは「送信元」でしかない)
      if (c.board === "bdcmd_x1") {
        const m = bdcmdDecodeCan(id, data, c.dev);
        if (m && m.type === "status") n.info = `${m.vb.toFixed(2)} V ` + (m.fl ? flagNames(m.fl).join(" ") : "異常なし");
        if (m && m.type === "status" && m.fl & 64) n.conflict = true; else if (m && m.type === "status") n.conflict = false;
      } else if (id === CAN.HEARTBEAT && data.length >= 4) {
        const f = data[0];
        n.info = `${(u16(data, 1) / 1000).toFixed(2)} V ` + [f & 1 ? "非常停止" : "", f & 2 ? "足回り有効" : "", f & 4 ? "PS4" : "", f & 8 ? "Wi-Fi" : "", f & 16 ? "低電圧" : ""].filter(Boolean).join(" ");
      }
    }
    const off = tr.on("can", ({ id, data }) => {
      if (ctx.conn().mode !== "can") return;
      frames++;
      const c = classifyCan(id);
      if (c.board) note(c, id, data);
      if ($("pause").checked) return;
      const f = $("flt").value;
      if (f && c.board !== f && !(f === "main_board" && c.board === "all")) return;
      const box = $("frames");
      box.append(el("div", {}, `${id.toString(16).padStart(3, "0")}  [${data.length}]  ${hex(data).padEnd(23)}  ${c.board ? (NAMES[c.board] || "全基板") + (c.dev != null ? " #" + c.dev : "") + " " + c.what : "不明"}`));
      while (box.childElementCount > 300) box.firstChild.remove();
      box.scrollTop = box.scrollHeight;
      ctx.markRx();
    });
    const timer = setInterval(() => {
      const now = performance.now(), dt = (now - t0) / 1000;
      t0 = now;
      $("fps").textContent = (frames / dt).toFixed(0) + " /s";
      $("load").textContent = ((frames / dt) * 120 / 1e6 * 100).toFixed(1) + " %";
      frames = 0;
      const rows = [...nodes.values()].sort((a, b) => a.board.localeCompare(b.board) || (a.dev ?? 0) - (b.dev ?? 0));
      for (const n of rows) { n.rate = (n.n - (n.prev || 0)) / dt; n.prev = n.n; }
      $("nodes").tBodies[0].replaceChildren(...rows.map((n) => {
        const age = (now - n.last) / 1000, alive = age < 3;
        return el("tr", {}, [el("td", {}, (NAMES[n.board] || (n.board === "all" ? "全基板宛て" : n.board)) + (n.present ? "" : "(指令の宛先のみ)")),
          el("td", {}, n.dev ?? "—"),
          el("td", {}, el("span", { class: "flag " + (n.conflict ? "bad" : alive && n.present ? "ok" : "") }, n.conflict ? "ID 重複で停止中" : alive ? "接続中" : "途絶") ), 
          el("td", { class: "num" }, n.rate.toFixed(0)), el("td", {}, alive ? "いま" : age.toFixed(0) + " 秒前")]);
      }));
      $("nodes").tBodies[0].querySelectorAll("tr").forEach((r, i) => { if (rows[i].info) r.children[2].append(" " + rows[i].info); });
      $("nonode").classList.toggle("hide", rows.length > 0);
    }, 1000);

    const send = (id, data) => { try { tr.sendCan(id, data); log.tx(`${id.toString(16)} ${hex(data)}`); } catch (e) { log.err(String(e.message || e)); } };
    $("es1").onclick = () => { send(CAN.ESTOP, [1]); setTimeout(() => send(CAN.ESTOP, [1]), 50); };
    $("es0").onclick = () => send(CAN.ESTOP, [0]);
    $("sgo").onclick = () => {
      const id = parseInt($("sid").value, 16), s = $("sdat").value.trim();
      if (!(id >= 0 && id <= 0x7ff)) return log.err("ID は 16 進で 000〜7ff");
      const data = $("sasc").checked ? toBytes(s) : (s.replace(/\s+/g, "").match(/../g) || []).map((h) => parseInt(h, 16));
      if (data.some(Number.isNaN)) return log.err("データは 16 進で入力してください");
      send(id, data);
    };
    return { onConnect() { nodes.clear(); $("frames").replaceChildren(); }, onDisconnect() {}, destroy() { off(); clearInterval(timer); } };
  },
};
