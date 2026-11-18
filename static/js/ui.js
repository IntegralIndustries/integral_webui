// 画面部品の小さなヘルパー。フレームワークは使わない。

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** el("div", {class:"a", onclick:fn}, [子...]) */
export function el(tag, attrs = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) e[k] = v;
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(kids)) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

export function html(s) {
  const t = document.createElement("template");
  t.innerHTML = s.trim();
  return t.content.firstElementChild;
}

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let bannerTimer;
export function banner(text, kind = "bad") {
  const b = document.getElementById("banner");
  b.textContent = text;
  b.className = kind === "bad" ? "" : kind;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.add("hide"), 15000);
}

/** スクロールするログ欄。 */
export class LogPanel {
  constructor(parent, height = 150) {
    this.box = el("div", { class: "log", style: `height:${height}px` });
    parent.append(this.box);
  }
  add(text, cls) {
    const d = el("div", cls ? { class: cls } : {}, text);
    this.box.append(d);
    while (this.box.childElementCount > 300) this.box.firstChild.remove();
    this.box.scrollTop = this.box.scrollHeight;
  }
  tx(t) { this.add("> " + t, "tx"); }
  err(t) { this.add(t, "err"); }
  clear() { this.box.replaceChildren(); }
}

/**
 * パラメータ(PID ゲイン・制限値など)の「設定 / 読」行を作る共通部品。
 * params: [{key, label, set:(v)=>cmd, get:()=>cmd, unit, lo, hi, note}]
 * io: {send(cmd), log(text, cls), dirty()}
 */
export class ParamEditor {
  constructor(parent, params, io) {
    this.params = params; this.io = io; this.inputs = {};
    parent.innerHTML = params.map((p, i) => `<div class="gain"><span>${esc(p.label)}${p.unit ? ` <i>[${esc(p.unit)}]</i>` : ""}</span>
      <input type="number" step="any" data-k="${i}" ${p.lo != null ? `min="${p.lo}" max="${p.hi}"` : ""} ${p.ph ? `placeholder="${esc(p.ph)}"` : ""}>
      <button data-i="${i}" data-a="set">設定</button><button data-i="${i}" data-a="get" title="この項目の現在値を基板から読む">読</button>
      ${p.note ? `<small>${esc(p.note)}<span data-h="${i}"></span></small>` : ""}</div>`).join("");
    parent.querySelectorAll("input[data-k]").forEach((inp) => (this.inputs[params[+inp.dataset.k].key] = inp));
    parent.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b || b.dataset.i == null) return;
      const p = params[+b.dataset.i];
      if (b.dataset.a === "get") return io.send(p.get());
      const v = this.inputs[p.key].value;
      if (v === "") return;
      if (p.lo != null && (+v < p.lo || +v > p.hi)) return io.log(`${p.label}は ${p.lo}〜${p.hi} の範囲で指定してください`, "err");
      io.send(p.set(v));
      io.dirty();
      setTimeout(() => io.send(p.get()), 120);   // 範囲外は基板側で無視されるので、読み戻して確認する
    };
    this.root = parent;
  }
  value(key) { const v = this.inputs[key]?.value; return v === "" || v == null ? null : +v; }
  /** 基板から読んだ値を入れる。入れたら true。 */
  got(key, v) {
    const e = this.inputs[key];
    if (!e) return false;
    e.value = +v.toPrecision(5);
    e.classList.add("got");
    setTimeout(() => e.classList.remove("got"), 800);
    return true;
  }
  hint(key, text) {
    const i = this.params.findIndex((p) => p.key === key);
    const h = this.root.querySelector(`[data-h="${i}"]`);
    if (h) h.textContent = text;
  }
  /** 全項目を、間隔をあけて読み出す(CAN は連続送信に弱いので 60ms あける)。 */
  readAll(extra = []) {
    [...extra, ...this.params.map((p) => p.get())].forEach((c, i) => setTimeout(() => this.io.send(c), i * 60));
  }
}

/** スライダー + 数値 + 送信ボタンの組(目標値の入力)。 */
export function localGet(key, def) { try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch { return def; } }
export function localSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }
