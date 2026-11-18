// LDS01_ESP32(LiDAR LDS-01 の Wi-Fi 送信基板)。UDP の 1 回転ぶんの点群と、8 方向の最短距離(CAN / UART)を表示する。
import { CAN, ldsDecodePacket, ldsDecodeCan, ldsDecodeLine, ldsSectors, ldsAngle, LDS_SECTORS } from "../protocol.js";
import { LogPanel, el } from "../ui.js";
import configTab from "./lds01_config.js";
import { espFlasher } from "./flasher.js";

const TEMPLATE = `
<main class="grid">
<aside>
  <div class="card">
    <h2>LiDAR の操作(UDP / UART)</h2>
    <div class="row"><button id="start" class="grow">START(回転開始)</button><button id="stop" class="grow">STOP(停止)</button><button id="info">情報 (?)</button></div>
    <div class="small mute">電源を入れると LDS は自動で回り始めます。STOP は LDS のモーターを止めます。</div>
  </div>
  <div class="card">
    <h2>状態</h2>
    <dl class="kv"><dt>データの出どころ</dt><dd id="src">—</dd><dt>回転速度</dt><dd id="rpm" class="val">—</dd><dt>電池</dt><dd id="vb" class="val">—</dd><dt>受信</dt><dd id="cnt" class="val">—</dd><dt>取りこぼし</dt><dd id="drop" class="val">—</dd><dt>基板の情報</dt><dd id="inf" class="small">—</dd></dl>
  </div>
  <div class="card">
    <h2>8 方向の最短距離 [mm]</h2>
    <div class="sec" id="sec"></div>
    <div class="small mute" style="margin-top:6px">CAN <code>0x180+ID</code> / <code>0x188+ID</code> と UART の値と同じ定義です(前から反時計回り、各 ±22.5°)。0 = データなし。UDP のときは受信した点群から計算します。</div>
  </div>
  <div class="card">
    <h2>表示</h2>
    <div class="row"><label>最大距離 <select id="rng"><option value="1000">1 m</option><option value="2000">2 m</option><option value="3500" selected>3.5 m</option></select></label>
      <label>色 <select id="col"><option value="int">強度</option><option value="dist">距離</option></select></label>
      <label>点の大きさ <input type="range" id="psz" min="1" max="6" value="2" style="width:80px"></label></div>
    <div class="row"><label><input type="checkbox" id="sectors" checked>方向の区切りと最短距離を表示</label></div>
  </div>
  <div class="card"><h2>ログ</h2><div id="logbox"></div><div class="row"><button id="clog">ログ消去</button></div></div>
</aside>
<section><canvas class="scan" id="cv"></canvas><div class="small mute" style="margin-top:6px">上が基板の「前」です(ROS の /scan と同じ向き: 反時計回りが正)。LDS をロボットに斜めに付けたときは、ファームの <code>SECTOR_FRONT_OFFSET_DEG</code> で「前」を変えられます。</div></section>
</main>`;

const heat = (t) => { t = Math.max(0, Math.min(1, t)); return `hsl(${240 - 240 * t},85%,${50 + 5 * t}%)`; };

export default {
  id: "lds01_esp32",
  stopCmds: () => [],   // UDP は SUB が途切れれば止まる。CAN / UART は受信だけ
  extraTabs: [{ id: "config", label: "config.h 作成", mount: configTab }, { id: "flash", label: "ファームウェア書き込み", mount: espFlasher("lds01_esp32") }],

  create(ctx) {
    const root = ctx.root;
    root.innerHTML = TEMPLATE;
    const $ = (id) => root.querySelector("#" + id);
    const tr = ctx.transport;
    const log = new LogPanel($("logbox"), 120);
    const st = { scan: null, sectors: new Array(8).fill(0), seq: null, n: 0, drop: 0, src: "", dirty: true, subTimer: 0, canHalf: [false, false] };

    $("sec").replaceChildren(...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => el("div", { id: "sec" + k }, [LDS_SECTORS[k], el("b", {}, "—")])));
    function showSectors(v) {
      st.sectors = v;
      v.forEach((x, k) => ($("sec" + k).lastChild.textContent = x ? x : "—"));
      st.dirty = true;
    }

    function send(t) {
      if (!tr.connected) return log.err("未接続です");
      const m = ctx.conn().mode;
      if (m === "can") return log.err("CAN は受信だけです(UDP か UART で接続してください)");
      try { m === "udp" ? tr.sendUdp(t) : tr.sendLine(t); log.tx(t); } catch (e) { log.err(String(e.message || e)); }
    }
    $("start").onclick = () => send("START"); $("stop").onclick = () => send("STOP"); $("info").onclick = () => send("?");
    $("clog").onclick = () => log.clear();

    // ---------- 受信 ----------
    function onPacket(bytes) {
      const p = ldsDecodePacket(bytes);
      if (!p) return;
      if (st.seq != null && p.seq > st.seq + 1) st.drop += p.seq - st.seq - 1;
      st.seq = p.seq; st.n++;
      st.scan = p; st.src = "UDP(点群)";
      $("rpm").textContent = p.rpm.toFixed(1) + " rpm"; $("vb").textContent = p.vb.toFixed(2) + " V";
      $("cnt").textContent = st.n + " 回転"; $("drop").textContent = st.drop + " 回転";
      showSectors(ldsSectors(p.dist));
      $("src").textContent = st.src;
      ctx.markRx();
    }
    function onInfo(m) { $("inf").textContent = m.text; if (m.fields.vb) $("vb").textContent = (+m.fields.vb).toFixed(2) + " V"; if (m.fields.rpm) $("rpm").textContent = m.fields.rpm + " rpm"; log.add("i " + m.text); }
    const offs = [
      tr.on("udp", ({ bytes }) => {
        if (ctx.conn().mode !== "udp") return;
        if (bytes[0] === 0x4c && bytes[1] === 0x44 && bytes[2] === 0x53 && bytes[3] === 0x31) return onPacket(bytes);   // "LDS1"
        for (const l of new TextDecoder().decode(bytes).split(/\r?\n/)) { if (!l.trim()) continue; const m = ldsDecodeLine(l.trim()); m.type === "info" ? onInfo(m) : log.add(l.trim()); }
      }),
      tr.on("line", ({ text }) => {
        if (ctx.conn().mode !== "uart") return;
        const m = ldsDecodeLine(text);
        if (m.type === "sectors8") { st.scan = null; st.src = "UART(8方向)"; $("src").textContent = st.src; $("rpm").textContent = m.rpm.toFixed(1) + " rpm"; showSectors(m.values); ctx.markRx(); }
        else if (m.type === "info") onInfo(m);
        else log.add(text);
      }),
      tr.on("can", ({ id, data }) => {
        const c = ctx.conn();
        if (c.mode !== "can") return;
        if (c.devId < 0 && id >= CAN.LDS_A && id < CAN.LDS_A + 8) { ctx.setDevId(id - CAN.LDS_A); log.add(`デバイスID自動検出: ${id - CAN.LDS_A}`); }
        const m = ldsDecodeCan(id, data, ctx.conn().devId);
        if (!m) return;
        const v = st.sectors.slice();
        m.values.forEach((x, i) => (v[m.base + i] = x));
        st.scan = null; st.src = "CAN(8方向)"; $("src").textContent = st.src;
        showSectors(v); ctx.markRx();
      }),
    ];

    // ---------- 描画 ----------
    const cv = $("cv");
    function draw() {
      if (!st.alive) return;
      requestAnimationFrame(draw);
      if (!st.dirty) return;
      st.dirty = false;
      const r = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * r)) { cv.width = Math.round(W * r); cv.height = Math.round(H * r); }
      const g = cv.getContext("2d");
      g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, W, H);
      const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const cx = W / 2, cy = H / 2, maxR = +$("rng").value, R = Math.min(W, H) / 2 - 26, k = R / maxR;
      const P = (deg, mm) => { const a = (deg * Math.PI) / 180; return [cx - Math.sin(a) * mm * k, cy - Math.cos(a) * mm * k]; };
      g.font = "11px system-ui"; g.lineWidth = 1; g.strokeStyle = css("--grid"); g.fillStyle = css("--mute"); g.textAlign = "center";
      const step = maxR <= 1000 ? 250 : 500;
      for (let m = step; m <= maxR; m += step) { g.beginPath(); g.arc(cx, cy, m * k, 0, 7); g.stroke(); g.fillText((m / 1000).toFixed(2) + " m", cx, cy - m * k - 2); }
      g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.stroke();
      if ($("sectors").checked) {
        g.strokeStyle = css("--line"); g.setLineDash([3, 4]);
        for (let s = 0; s < 8; s++) { const [x, y] = P(s * 45 + 22.5, maxR); g.beginPath(); g.moveTo(cx, cy); g.lineTo(x, y); g.stroke(); }
        g.setLineDash([]);
      }
      // 前(上)の矢印
      g.fillStyle = css("--acc"); g.beginPath(); g.moveTo(cx, cy - 16); g.lineTo(cx - 6, cy); g.lineTo(cx + 6, cy); g.fill();
            const sc = st.scan, sz = +$("psz").value;
      if (sc) {
        const byInt = $("col").value === "int";
        let imax = 1;
        if (byInt) for (let i = 0; i < sc.n; i++) if (sc.inten[i] > imax) imax = sc.inten[i];
        for (let i = 0; i < sc.n; i++) {
          const d = sc.dist[i];
          if (d < 120 || d > 3500 || d > maxR) continue;
          const [x, y] = P(ldsAngle(i, sc.n), d);
          g.fillStyle = byInt ? heat(sc.inten[i] / Math.min(imax, 2000)) : heat(d / maxR);
          g.fillRect(x - sz / 2, y - sz / 2, sz, sz);
        }
      }
      if ($("sectors").checked) {
        g.textAlign = "center";
        st.sectors.forEach((mm, s) => {
          const a = s * 45;
          if (mm && mm <= maxR) {   // 最短距離の位置に印
            const [x, y] = P(a, mm);
            g.strokeStyle = css("--bad"); g.lineWidth = 2; g.beginPath(); g.arc(x, y, 6, 0, 7); g.stroke(); g.lineWidth = 1;
          }
          const [lx, ly] = P(a, maxR * 1.0 + 12 / k);
          g.fillStyle = mm ? css("--fg") : css("--mute");
          g.fillText(mm ? mm + "" : "—", lx, ly + 4);
        });
      }
      if (!sc && !st.sectors.some(Boolean)) { g.fillStyle = css("--mute"); g.font = "14px system-ui"; g.fillText(tr.connected ? "データを待っています…" : "未接続です。UDP(Wi-Fi)で接続すると点群が見えます", cx, cy + R / 2); }
    }
    st.alive = true; requestAnimationFrame(draw);
    ["rng", "col", "psz", "sectors"].forEach((id) => ($(id).onchange = $(id).oninput = () => (st.dirty = true)));
    const ro = new ResizeObserver(() => (st.dirty = true)); ro.observe(cv);
    const themeMq = matchMedia("(prefers-color-scheme: dark)"); const onTheme = () => (st.dirty = true); themeMq.addEventListener?.("change", onTheme);

    return {
      onConnect() {
        st.seq = null; st.n = 0; st.drop = 0; st.dirty = true;
        const c = ctx.conn();
        if (c.mode === "udp") {   // SUB を 1 秒ごとに送らないと、基板は 3 秒で送るのをやめる
          const sub = () => { try { tr.sendUdp("SUB"); } catch {} };
          sub(); clearInterval(st.subTimer); st.subTimer = setInterval(sub, 1000);
          setTimeout(() => send("?"), 300);
        } else if (c.mode === "uart") setTimeout(() => send("?"), 300);
      },
      onDisconnect() { clearInterval(st.subTimer); },
      destroy() { st.alive = false; clearInterval(st.subTimer); offs.forEach((f) => f()); ro.disconnect(); themeMq.removeEventListener?.("change", onTheme); },
    };
  },
};
