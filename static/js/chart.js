// リアルタイムグラフ(HQDD1 の Web UI のグラフを、基板に依存しない形にしたもの)。
//
// ChartBoard: ツールバー(表示幅・グラフ追加・一時停止・クリア・CSV)+ グラフの列。
//   opts.series  : {key: [名前, 単位, 色番号, 破線?]}
//   opts.presets : {name: {label, keys:[], pool?:[], title, follow?:true}}  「グラフ追加」で選べる組み合わせ(pool = 選べる項目の候補)
//   opts.follow  : () => keys    「モード連動」グラフが今表示する項目(基板の状態で変わる)
//   opts.storage : localStorage のキー(グラフの構成を覚える)
//   opts.initial : 初回に出すグラフ [{keys,title}|{follow:true}]
//   opts.maxPoints, opts.note : 保持する点数 / ツールバー右の注記
import { el } from "./ui.js";

const COL = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8"];
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

class Chart {
  constructor(board, cfg, data) {
    this.board = board;
    this.cfg = { keys: [], follow: false, auto: true, min: -1, max: 1, h: 300, ...cfg };
    this.data = data || null;   // 指定時は静的なグラフ(高速キャプチャ用)
    const S = board.series;
    this.box = el("div", { class: "chart" });
    const top = el("div", { class: "top" });
    this.title = el("b", {}, this.cfg.title || "グラフ");
    top.append(this.title);
    this.chips = {};
    for (const k of this.data ? this.cfg.keys : this.cfg.pool || Object.keys(S)) {
      const [lab, unit, ci] = S[k];
      const c = el("span", { class: "chip", title: unit }, [el("i", { style: `background:var(${COL[ci % 8]})` }), lab, el("span", { class: "val" })]);
      c.onclick = () => this.toggle(k);
      this.chips[k] = c;
      top.append(c);
    }
    top.append(el("span", { class: "sp" }));
    const yr = el("span", { class: "yr" });
    yr.innerHTML = `<label>縦軸 <select><option value="a">自動</option><option value="f">固定</option></select></label>
      <label class="ym hide"><input type="number" step="any"> ～ <input type="number" step="any"></label>`;
    const sel = yr.querySelector("select"), ym = yr.querySelector(".ym"), [i0, i1] = ym.querySelectorAll("input");
    sel.value = this.cfg.auto ? "a" : "f"; i0.value = this.cfg.min; i1.value = this.cfg.max;
    ym.classList.toggle("hide", this.cfg.auto);
    sel.onchange = () => { this.cfg.auto = sel.value === "a"; ym.classList.toggle("hide", this.cfg.auto); board.save(); };
    i0.onchange = i1.onchange = () => { this.cfg.min = +i0.value; this.cfg.max = +i1.value; board.save(); };
    top.append(yr);
    top.append(el("button", { title: "このグラフを削除", onclick: () => { this.box.remove(); board.charts.splice(board.charts.indexOf(this), 1); board.save(); } }, "×"));
    this.cvw = el("div", { class: "cvw", style: `height:${this.cfg.h}px` });
    this.cv = el("canvas");
    this.cvw.append(this.cv);
    this.cvw.addEventListener("mouseup", () => { this.cfg.h = this.cvw.clientHeight; board.save(); });
    this.box.append(top, this.cvw);
    this.refreshChips();
  }

  activeKeys() { return this.cfg.follow ? this.board.follow() : this.cfg.keys; }

  toggle(k) {
    if (this.cfg.follow) { this.cfg.follow = false; this.cfg.keys = this.activeKeys().slice(); }   // 手で触ったら連動を解除
    const i = this.cfg.keys.indexOf(k);
    i < 0 ? this.cfg.keys.push(k) : this.cfg.keys.splice(i, 1);
    this.refreshChips();
    this.board.save();
  }

  refreshChips() {
    const act = this.activeKeys();
    for (const k in this.chips) this.chips[k].classList.toggle("act", act.includes(k));
    this.title.textContent = this.cfg.title || (this.cfg.follow ? "モード連動" : "グラフ");
  }

  draw(buf0, t1, win) {
    const S = this.board.series;
    const buf = this.data || buf0;
    if (this.data) { t1 = buf.length ? buf[buf.length - 1].t : 0; win = t1 || 1; }
    const keys = this.activeKeys();
    if (this.cfg.follow && this._k !== keys.join()) { this._k = keys.join(); this.refreshChips(); }
    const cv = this.cv, r = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * r) || cv.height !== Math.round(H * r)) { cv.width = Math.round(W * r); cv.height = Math.round(H * r); }
    const g = cv.getContext("2d");
    g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, W, H);
    const L = 52, R = 8, T = 6, B = 18, pw = W - L - R, ph = H - T - B, t0 = t1 - win;
    // 長い履歴でも軽いように、表示範囲の先頭を二分探索し、点が多い時は間引く
    let a = 0, b = buf.length;
    while (a < b) { const m = (a + b) >> 1; if (buf[m].t < t0 - 1) a = m + 1; else b = m; }
    const i0 = a, stride = Math.max(1, Math.floor((buf.length - i0) / (pw * 2)));
    let lo = Infinity, hi = -Infinity;
    if (this.cfg.auto) {
      for (const k of keys) for (let i = buf.length - 1; i >= i0; i -= stride) {
        const p = buf[i]; if (p.t < t0) break;
        const v = p[k]; if (v == null) continue;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
      if (!isFinite(lo)) { lo = -1; hi = 1; }
      if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }
      const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    } else { lo = Math.min(this.cfg.min, this.cfg.max); hi = Math.max(this.cfg.min, this.cfg.max); if (hi - lo < 1e-9) hi = lo + 1; }
    const X = (t) => L + ((t - t0) / win) * pw, Y = (v) => T + (1 - (v - lo) / (hi - lo)) * ph;
    g.font = "11px system-ui"; g.fillStyle = css("--mute"); g.strokeStyle = css("--grid"); g.lineWidth = 1;
    const rows = Math.max(4, Math.min(10, Math.floor(ph / 36)));
    for (let i = 0; i <= rows; i++) {
      const v = lo + ((hi - lo) * i) / rows, y = Y(v);
      g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
      g.textAlign = "right"; g.fillText(v.toFixed(Math.abs(hi - lo) < 2 ? 3 : Math.abs(hi - lo) < 20 ? 2 : 1), L - 4, y + 3);
    }
    g.textAlign = "center";
    for (let i = 0; i <= 4; i++) { const t = t0 + (win * i) / 4, d = t - t1; g.fillText(this.data ? d.toFixed(2) + "s" : win >= 120 ? (d / 60).toFixed(1) + "分" : d.toFixed(0) + "s", X(t), H - 4); }
    if (lo < 0 && hi > 0) { g.strokeStyle = css("--mute"); g.beginPath(); g.moveTo(L, Y(0)); g.lineTo(W - R, Y(0)); g.stroke(); }
    g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
    for (const k of keys) {
      const sd = S[k]; if (!sd) continue;
      g.strokeStyle = css(COL[sd[2] % 8]); g.lineWidth = 1.8; g.setLineDash(sd[3] ? [6, 4] : []);
      g.beginPath();
      let first = true;
      for (let i = i0; i < buf.length; i += stride) {
        const p = buf[i], v = p[k];
        if (v == null) { first = true; continue; }
        first ? g.moveTo(X(p.t), Y(v)) : g.lineTo(X(p.t), Y(v));
        first = false;
      }
      const pl = buf[buf.length - 1];
      if (pl && pl[k] != null && stride > 1) g.lineTo(X(pl.t), Y(pl[k]));
      g.stroke();
    }
    g.restore();
    const last = buf[buf.length - 1];
    for (const k in this.chips) {
      const e = this.chips[k].lastChild, on = keys.includes(k);
      e.textContent = on && last && last[k] != null ? " " + last[k].toFixed(3) : "";
    }
  }
}

export class ChartBoard {
  constructor(root, opts) {
    this.series = opts.series;
    this.presets = opts.presets;
    this.follow = opts.follow || (() => []);
    this.storage = opts.storage;
    this.maxPoints = opts.maxPoints || 20000;
    this.charts = [];
    this.buf = [];
    this.paused = false;
    this.alive = true;
    this.lastDraw = 0;
    const bar = el("div", { class: "card toolbar" });
    bar.innerHTML = `<label>表示幅 <select class="win"><option value="1">1秒</option><option value="2">2秒</option><option value="5">5秒</option><option value="10" selected>10秒</option><option value="30">30秒</option><option value="60">1分</option><option value="120">2分</option><option value="300">5分</option></select></label>
      <select class="preset">${Object.entries(this.presets).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join("")}<option value="">空のグラフ</option></select>
      <button class="pri add">＋ グラフ追加</button><button class="pause">一時停止</button><button class="clear">クリア</button><button class="csv">CSV保存</button>
      <span class="mute small">${opts.note || ""}</span>`;
    this.wrap = el("div", { class: "charts" });
    root.append(bar, this.wrap);
    this.win = bar.querySelector(".win");
    bar.querySelector(".add").onclick = () => { this.addPreset(bar.querySelector(".preset").value); };
    const pb = bar.querySelector(".pause");
    pb.onclick = () => { this.paused = !this.paused; pb.textContent = this.paused ? "再開" : "一時停止"; pb.classList.toggle("on", this.paused); };
    bar.querySelector(".clear").onclick = () => this.clear();
    bar.querySelector(".csv").onclick = () => this.csv(opts.csvKeys || Object.keys(this.series), opts.csvName || "integral");
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this.storage) || "null"); } catch {}
    const init = Array.isArray(saved) && saved.length ? saved : opts.initial || [];
    init.forEach((c) => this.add(c));
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  add(cfg, data) {
    const c = new Chart(this, cfg, data);
    this.charts.push(c);
    data ? this.wrap.prepend(c.box) : this.wrap.append(c.box);
    return c;
  }

  addPreset(p) {
    const pr = this.presets[p];
    this.add(pr ? (pr.follow ? { follow: true } : { keys: pr.keys.slice(), title: pr.title, pool: pr.pool }) : {});
    this.save();
  }

  save() {
    if (!this.storage) return;
    try { localStorage.setItem(this.storage, JSON.stringify(this.charts.filter((c) => !c.data).map((c) => c.cfg))); } catch {}
  }

  push(row) {
    if (this.paused) return;
    this.buf.push(row);
    if (this.buf.length > this.maxPoints + 2000) this.buf.splice(0, this.buf.length - this.maxPoints);
  }

  clear() { this.buf.length = 0; }

  csv(keys, name) {
    const k = ["t", ...keys];
    const txt = [k.join(",")].concat(this.buf.map((p) => k.map((x) => (p[x] == null ? "" : p[x])).join(","))).join("\n");
    const a = el("a", { href: URL.createObjectURL(new Blob([txt], { type: "text/csv" })), download: `${name}_${Date.now()}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  _loop() {
    if (!this.alive) return;
    const buf = this.buf;
    if (!this.paused && buf.length) {
      const t1 = buf[buf.length - 1].t, w = +this.win.value;
      const slow = w >= 120;   // 長い表示幅は描画が重いので間引いて更新する
      const now = performance.now();
      if (!slow || now - this.lastDraw >= 150) {
        this.lastDraw = now;
        for (const c of this.charts) if (!c.data) c.draw(buf, t1, w);
      }
    }
    for (const c of this.charts) if (c.data) c.draw();
    requestAnimationFrame(this._loop);
  }

  destroy() { this.alive = false; }
}
