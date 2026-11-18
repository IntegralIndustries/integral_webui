// 通信の経路を 1 つにまとめる。基板ごとのコードは、経路(サーバ経由 / Web Serial)を意識しない。
//
//   サーバ経由 (server.py):  CAN / UART / UDP すべて
//   ブラウザ直結 (Web Serial): UART(USB シリアル)だけ。サーバ不要。Chrome / Edge のみ
//
// イベント: status{connected,mode} / can{id,data,t} / line{text} / udp{bytes} / error{text} / tx{text}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Transport {
  constructor() {
    this.h = {};
    this.backend = false;       // server.py に繋がっているか
    this.ports = { serial: [], can: [] };
    this.connected = false;
    this.mode = null;
    this.via = null;            // "server" | "web"
    this.onClose = [];
    this._ws = null;
    this._serial = null;
    this.webSerial = typeof navigator !== "undefined" && !!navigator.serial;
    this.openWs();
  }

  on(ev, fn) { (this.h[ev] ||= new Set()).add(fn); return () => this.h[ev].delete(fn); }
  emit(ev, v) { for (const f of this.h[ev] || []) { try { f(v); } catch (e) { console.error(e); } } }

  // ---------- サーバへの接続(自動再接続) ----------
  openWs() {
    // 公開ページ(https)から ws:// は作れない。サーバ無しとして扱う
    if (location.protocol !== "http:") return this.emit("backend", false);
    let ws;
    try { ws = new WebSocket(`ws://${location.host}/ws`); } catch { return this.emit("backend", false); }
    this._ws = ws;
    ws.onopen = async () => { this.backend = true; await this.loadPorts().catch(() => {}); this.emit("backend", true); };
    ws.onmessage = (e) => this._fromServer(JSON.parse(e.data));
    ws.onclose = () => {
      const was = this.backend;
      this.backend = false;
      if (was) {
        if (this.via === "server") this._setStatus(false, null);
        this.emit("backend", false);
      }
      setTimeout(() => this.openWs(), 3000);
    };
  }

  async loadPorts() {
    if (!this.backend) return this.ports;
    this.ports = await (await fetch("/api/ports")).json();
    return this.ports;
  }

  _fromServer(m) {
    if (m.type === "status") {
      if (m.connected && !this.via) this.via = "server";
      this._setStatus(m.connected, m.mode);
    } else if (m.type === "can") {
      for (const [t, id, data] of m.frames) this.emit("can", { id, data, t });
    } else if (m.type === "line") this.emit("line", { text: m.text });
    else if (m.type === "udp") {
      const bin = atob(m.b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      this.emit("udp", { bytes });
    } else if (m.type === "error") this.emit("error", { text: m.text });
  }

  _setStatus(connected, mode) {
    this.connected = connected;
    this.mode = connected ? mode : null;
    if (!connected) this.via = null;
    this.emit("status", { connected, mode: this.mode, via: this.via });
  }

  // ---------- 接続 ----------
  /**
   * cfg: {mode:"can"|"uart"|"udp", via:"server"|"web", iface, port, baud, host, udpPort}
   * onClose: 切断時(ブラウザを閉じたときも)に基板へ送る停止コマンド [{kind,id,data|text}]
   */
  async connect(cfg, onClose = []) {
    this.onClose = onClose;
    if (cfg.via === "web") return this._webOpen(cfg);
    if (!this.backend) throw new Error("サーバ(server.py)に接続されていません");
    this.via = "server";
    const base = { type: "open", mode: cfg.mode, on_close: onClose };
    if (cfg.mode === "can") this._send({ ...base, iface: cfg.iface });
    else if (cfg.mode === "uart") this._send({ ...base, port: cfg.port, baud: cfg.baud });
    else this._send({ ...base, host: cfg.host, port: cfg.udpPort });
  }

  setOnClose(list) {
    this.onClose = list;
    if (this.via === "server") this._send({ type: "set_on_close", on_close: list });
  }

  async disconnect(sendStop = true) {
    if (sendStop) for (const tx of this.onClose) { try { this.tx(tx); } catch {} }
    if (this.via === "web") return this._webClose();
    this._send({ type: "close" });
  }

  _send(o) { if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(o)); }

  // ---------- 送信 ----------
  tx(tx) {
    if (!this.connected) throw new Error("未接続です");
    if (tx.kind !== this.mode) throw new Error(`${this.mode} で接続中なので ${tx.kind} は送れません`);
    if (tx.kind === "can" && tx.data.length > 8) throw new Error("CAN は 1 フレーム 8 バイトまで");
    this.emit("tx", tx);
    if (this.via === "web") return this._webWrite(tx.text);
    this._send({ type: "tx", ...tx });
  }
  sendCan(id, data) { this.tx({ kind: "can", id, data }); }
  sendLine(text) { this.tx({ kind: "uart", text }); }
  sendUdp(text) { this.tx({ kind: "udp", text }); }

  // ---------- Web Serial(UART のみ) ----------
  async _webOpen(cfg) {
    if (!this.webSerial) throw new Error("このブラウザは Web Serial 非対応です(Chrome / Edge を使ってください)");
    if (this._serial) return;
    let port;
    try { port = await navigator.serial.requestPort(); } catch (e) { throw new Error(friendly(e)); }
    if (port.readable || port.writable) { try { await port.close(); } catch {} }   // 前回の残りを閉じる
    try { await port.open({ baudRate: cfg.baud, bufferSize: 8192 }); }
    catch (e) { throw new Error(friendly(e)); }
    const c = (this._serial = { port, writer: port.writable.getWriter(), reader: null, alive: true, done: null });
    this.via = "web";
    this._setStatus(true, "uart");
    c.done = this._webRead(c);
  }

  async _webRead(c) {
    const dec = new TextDecoder();
    let acc = "";
    while (c.alive && c.port.readable) {   // 致命的でない読み取りエラーは再試行
      c.reader = c.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await c.reader.read();
          if (done) break;
          acc += dec.decode(value, { stream: true });
          if (acc.length > 4096 && acc.indexOf("\n") < 0) acc = "";
          let i;
          while ((i = acc.indexOf("\n")) >= 0) { const t = acc.slice(0, i).trim(); acc = acc.slice(i + 1); if (t) this.emit("line", { text: t }); }
        }
      } catch (e) { if (c.alive) this.emit("error", { text: "シリアル読み取りエラー: " + (e.name || e) + "(再試行)" }); }
      finally { try { c.reader.releaseLock(); } catch {} c.reader = null; }
      if (!c.alive) return;
      await sleep(50);
    }
    if (c.alive && this._serial === c) {   // USB が抜けた等
      c.alive = false;
      await this._webRelease(c);
      this._serial = null;
      this.emit("error", { text: "シリアルポートが切断されました" });
      this._setStatus(false, null);
    }
  }

  async _webWrite(text) {
    const c = this._serial;
    if (!c) throw new Error("未接続です");
    await c.writer.write(new TextEncoder().encode(text.replace(/\n$/, "") + "\n"));
  }

  async _webRelease(c) {
    try { c.writer.releaseLock(); } catch {}
    try { await c.port.close(); } catch (e) { this.emit("error", { text: "ポートを閉じられません: " + e }); }
  }

  async _webClose() {
    const c = this._serial;
    if (!c) return;
    await sleep(80);   // 直前の停止コマンドが出るのを待つ
    c.alive = false;
    try { if (c.reader) await c.reader.cancel(); } catch {}
    try { await c.done; } catch {}
    await this._webRelease(c);
    this._serial = null;
    this._setStatus(false, null);
  }

  /** タブを閉じるとき(ベストエフォート)。サーバ経由はサーバ側が停止を送る。 */
  bestEffortStop() {
    if (this.via === "web" && this._serial) for (const tx of this.onClose) { try { this._webWrite(tx.text); } catch {} }
  }
}

function friendly(e) {
  const n = e && e.name, m = String((e && e.message) || e);
  if (n === "NotFoundError") return "ポートが選択されませんでした";
  if (n === "NetworkError" || /Failed to open/i.test(m)) return "ポートを開けません。他のアプリ(server.py、シリアルモニタ、別のタブ)が使用中でないか確認してください";
  if (n === "InvalidStateError") return "ポートが既に開かれています。USB を抜き差しして、ページを再読み込みしてください";
  return m;
}
