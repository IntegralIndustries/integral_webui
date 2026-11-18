// ブラウザからのファームウェア書き込み。
//   ESP32 (main_board / LDS01_ESP32): esptool-js + Web Serial(USB-C / DevKit の USB)
//   STM32G431 (BDCMD_X1): USB DFU(DfuSe)を WebUSB で話す(このファイルの中に実装)
// どちらも Chrome / Edge のみ。https か localhost で開く必要がある。
// 書き込むファイルは、PlatformIO のビルドで出来る .bin(.pio/build/<env>/ の中)を選ぶか、GitHub のリリースから取る。
import { el, esc, sleep } from "../ui.js";

const ESPTOOL_URL = "https://cdn.jsdelivr.net/npm/esptool-js@0.5.7/bundle.js";
const hex = (n) => "0x" + n.toString(16);

/** 共通の枠: ファイルの選択・進み具合・ログ。 */
function frame(root, { title, intro, warn }) {
  root.innerHTML = `<div class="info fl"><div style="max-width:860px;margin:0 auto">
    <div class="card"><h2>${esc(title)}</h2><div class="small" id="intro">${intro}</div>
      ${warn ? `<div class="note w">⚠ ${warn}</div>` : ""}
      <div id="body"></div>
      <progress id="prog" value="0" max="100" style="width:100%;margin-top:8px"></progress>
      <div class="log" id="flog" style="height:200px;margin-top:6px"></div></div></div></div>`;
  const $ = (id) => root.querySelector("#" + id);
  const log = (t, c) => { const d = el("div", c ? { class: c } : {}, t); $("flog").append(d); $("flog").scrollTop = 1e9; };
  return { $, log, body: $("body"), progress: (p) => ($("prog").value = p) };
}

const readBuf = (f) => f.arrayBuffer();
const toBinString = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return s; };

/** GitHub の最新リリースのファイル一覧を出して、選ばせる(リリースが無ければ案内を出す)。 */
async function releasePicker(container, repo, exts, onPick, log) {
  const box = el("div", { class: "row" }, [el("button", { type: "button" }, "GitHub のリリースから取得"), el("span", { class: "small mute" }, `${repo} の最新リリース`)]);
  container.append(box);
  box.firstChild.onclick = async () => {
    try {
      const r = await fetch(`https://api.github.com/repos/IntegralIndustries/${repo}/releases/latest`);
      if (r.status === 404) return log("リリースがまだありません。PlatformIO で自分でビルドした .bin を選んでください(.pio/build/<env>/ の中)。", "err");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const rel = await r.json();
      const assets = (rel.assets || []).filter((a) => exts.some((e) => a.name.endsWith(e)));
      if (!assets.length) return log(`リリース ${rel.tag_name} に ${exts.join(" / ")} のファイルがありません`, "err");
      const sel = el("select", {}, assets.map((a, i) => el("option", { value: i }, `${a.name} (${rel.tag_name})`)));
      const go = el("button", { type: "button", class: "pri" }, "これを使う");
      box.append(sel, go);
      go.onclick = async () => {
        try {
          const a = assets[+sel.value], res = await fetch(a.browser_download_url);
          if (!res.ok) throw new Error("HTTP " + res.status);
          onPick(new File([await res.blob()], a.name));
          log(`${a.name} を取得しました`);
        } catch (e) { log("取得できませんでした(ブラウザからはダウンロードできないことがあります。手でダウンロードして選んでください): " + e.message, "err"); }
      };
    } catch (e) { log("リリースを調べられませんでした: " + e.message, "err"); }
  };
}

/**
 * このページに同梱したビルド済みファームウェア(static/firmware/<基板>/。tools/update_firmware.py で更新)。
 * PC にファイルを用意しなくても、ボタン 1 つで書き込む候補に入る。groups = [[ボタンの名前, ファイル名の配列], ...]
 */
async function builtinPicker(container, repo, groups, onPick, log) {
  let m;
  try {
    const r = await fetch("firmware/manifest.json", { cache: "no-cache" });
    if (!r.ok) return;
    m = (await r.json())[repo];
  } catch { return; }
  if (!m) return;
  const box = el("div", { class: "row" }, [el("span", { class: "small mute" }, `同梱(${repo} ${m.commit}、${String(m.built).slice(0, 10)} ビルド。ロボットごとの設定は既定のまま):`)]);
  for (const [label, names] of groups) {
    const files = names.filter((n) => m.files.includes(n));
    if (!files.length) continue;
    const b = el("button", { type: "button", class: "pri" }, label);
    b.onclick = async () => {
      try {
        for (const f of files) {
          const res = await fetch(`firmware/${repo}/${f}`);
          if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
          onPick(new File([await res.blob()], f));
        }
        log(`同梱の ${files.join(" / ")} を追加しました`);
      } catch (e) { log("同梱のファイルを取得できません: " + e.message, "err"); }
    };
    box.append(b);
  }
  container.append(box);
}

// =====================================================================
// ESP32
// =====================================================================
const ESP_AUTO = [[/bootloader/i, 0x1000], [/partition/i, 0x8000], [/boot_app0/i, 0xe000], [/firmware|app|\.ino/i, 0x10000]];

export function espFlasher(repo) {
  return function mount(root, ctx) {
    const F = frame(root, {
      title: "ESP32 にファームウェアを書き込む",
      intro: `USB ケーブルで PC につなぎ(main_board は USB-C、LDS01_ESP32 は DevKit の USB。DevKit は基板から外してもよい)、
        <b>「同梱の…」ボタンを押せば、ファイルの用意は要りません</b>(ロボットごとの設定は既定のままのビルド)。自分でビルドしたものを使うときは、ファイルを選んで「書き込む」。ファイルは <code>cd firmware && pio run</code> のあと <code>.pio/build/&lt;env&gt;/</code> にできます。
        <b>firmware.bin だけ</b>なら 0x10000 に書きます(すでに動いている基板の更新)。<b>新品の ESP32</b> は <code>bootloader.bin</code>(0x1000)、<code>partitions.bin</code>(0x8000)、<code>boot_app0.bin</code>(0xe000)も一緒に選びます(ファイル名からアドレスを自動で入れます)。`,
      warn: "書き込み中は電源・USB を抜かないでください。この画面の接続(USB シリアル)は、先に「切断」してください(同じポートを 2 か所で開けません)。",
    });
    const rows = [];
    const list = el("div");
    const addRow = (file) => {
      const auto = ESP_AUTO.find(([re]) => re.test(file.name));
      const addr = el("input", { type: "text", value: auto ? hex(auto[1]) : "0x10000", style: "width:90px" });
      const row = el("div", { class: "row" }, [el("span", { class: "grow" }, `${file.name} (${(file.size / 1024).toFixed(1)} KB)`), el("label", {}, ["アドレス ", addr]), el("button", { type: "button", onclick: () => { rows.splice(rows.indexOf(r), 1); row.remove(); } }, "×")]);
      const r = { file, addr }; rows.push(r); list.append(row);
    };
    const pick = el("input", { type: "file", accept: ".bin", multiple: true, hidden: true });
    pick.onchange = () => { [...pick.files].forEach(addRow); pick.value = ""; };
    const baud = el("select", {}, ["115200", "230400", "460800", "921600"].map((b) => el("option", { value: b, selected: b === "460800" }, b)));
    const erase = el("input", { type: "checkbox" });
    const go = el("button", { type: "button", class: "pri" }, "書き込む");
    F.body.append(el("div", { class: "row" }, [el("button", { type: "button", onclick: () => pick.click() }, ".bin を選ぶ(複数可)"), pick, el("label", {}, ["書き込み速度 ", baud]), el("label", {}, [erase, "全消去してから書く"])]), list);
    builtinPicker(F.body, repo, [["同梱の一式(新品の ESP32・初めて書くとき)", ["bootloader.bin", "partitions.bin", "boot_app0.bin", "firmware.bin"]], ["同梱の firmware.bin だけ(すでに書いてある基板の更新)", ["firmware.bin"]]], addRow, F.log);
    releasePicker(F.body, repo, [".bin"], addRow, F.log);
    F.body.append(el("div", { class: "row" }, [go]));

    go.onclick = async () => {
      if (!rows.length) return F.log("ファイルを選んでください", "err");
      if (!navigator.serial) return F.log("このブラウザは Web Serial 非対応です(Chrome / Edge)", "err");
      if (ctx.transport.connected) return F.log("先に画面上部の「切断」を押してください", "err");
      const files = [];
      for (const r of rows) {
        const addr = parseInt(r.addr.value, 16), u8 = new Uint8Array(await readBuf(r.file));
        if (!(addr >= 0)) return F.log(`${r.file.name}: アドレスが正しくありません`, "err");
        if (addr === 0x10000 && u8[0] !== 0xe9) return F.log(`${r.file.name}: ESP32 のアプリのイメージではありません(先頭が 0xE9 でない)。firmware.bin を選んでいますか?`, "err");
        files.push({ data: toBinString(u8), address: addr, name: r.file.name });
      }
      // 新品の ESP32(標準のパーティション)は、アプリの領域が約 1.3MB。それを超えるファームは、partitions.bin も書かないと起動しない
      const big = files.find((f) => f.address === 0x10000 && f.data.length > 0x140000);
      if (big && !files.some((f) => f.address === 0x8000)) {
        if (!confirm(`${big.name} は ${(big.data.length / 1048576).toFixed(2)} MB あります。新品の ESP32(標準のパーティション)は約 1.3 MB までしか入らず、firmware.bin だけでは起動しません。\n\npartitions.bin(0x8000)なしで続けますか?(すでに同じファームを書いた基板の更新なら OK)`)) return;
      }
      if (!confirm(`${files.map((f) => `${f.name} → ${hex(f.address)}`).join("\n")}\n\nを書き込みます。続けますか?`)) return;
      go.disabled = true; F.progress(0);
      let transport;
      try {
        F.log("esptool-js を読み込み中…");
        const { ESPLoader, Transport } = await import(/* @vite-ignore */ ESPTOOL_URL);
        const port = await navigator.serial.requestPort();
        transport = new Transport(port, false);
        const term = { clean() {}, writeLine: (d) => F.log(d), write() {} };
        const loader = new ESPLoader({ transport, baudrate: +baud.value, romBaudrate: 115200, terminal: term });
        F.log("基板に接続中…(つながらないときは、BOOT を押しながら EN を押して離す)");
        const chip = await loader.main();
        F.log("チップ: " + chip);
        const total = files.reduce((s, f) => s + f.data.length, 0), done = new Array(files.length).fill(0);
        await loader.writeFlash({
          fileArray: files.map(({ data, address }) => ({ data, address })), flashSize: "keep", flashMode: "keep", flashFreq: "keep", eraseAll: erase.checked, compress: true,
          reportProgress: (i, written, t) => { done[i] = (written / t) * files[i].data.length; F.progress((done.reduce((a, b) => a + b, 0) / total) * 100); },
        });
        F.progress(100);
        await loader.after();   // ハードリセットして、書いたプログラムを起動
        F.log("書き込みが終わりました。基板を再起動しました。", "");
      } catch (e) { F.log("失敗: " + (e.message || e), "err"); }
      finally { try { await transport?.disconnect(); } catch {} go.disabled = false; }
    };
    return { destroy() {} };
  };
}

// =====================================================================
// STM32 USB DFU(DfuSe)
// =====================================================================
const DFU = { DNLOAD: 1, GETSTATUS: 3, CLRSTATUS: 4, ABORT: 6 };
const ST = { appIDLE: 0, dfuIDLE: 2, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5, dfuMANIFEST: 7, dfuMANIFEST_WAIT_RESET: 8, dfuERROR: 10 };

export class DfuSeDevice {
  constructor(device) { this.dev = device; this.iface = null; this.alt = 0; this.xfer = 1024; this.sectors = []; }

  async open() {
    const d = this.dev;
    await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    // 「Internal Flash」の代替設定を探す(文字列は "@Internal Flash  /0x08000000/64*002Kg")
    for (const itf of d.configuration.interfaces) for (const a of itf.alternates) {
      if (a.interfaceClass === 0xfe && a.interfaceSubclass === 1 && a.interfaceName && /internal flash/i.test(a.interfaceName)) {
        this.iface = itf.interfaceNumber; this.alt = a.alternateSetting; this.layout = a.interfaceName;
      }
    }
    if (this.iface == null) throw new Error("DFU のフラッシュ領域(Internal Flash)が見つかりません");
    await d.claimInterface(this.iface);
    await d.selectAlternateInterface(this.iface, this.alt);
    this.sectors = parseLayout(this.layout);
    try {   // 構成ディスクリプタから DFU の転送サイズを読む
      const r = await d.controlTransferIn({ requestType: "standard", recipient: "device", request: 6, value: 0x0200, index: 0 }, 255);
      const b = new Uint8Array(r.data.buffer);
      for (let i = 0; i + 9 <= b.length; i += b[i] || 1) if (b[i] === 9 && b[i + 1] === 0x21) { this.xfer = Math.min(b[i + 5] | (b[i + 6] << 8), 2048) || 1024; break; }
    } catch {}
  }

  async status() {
    const r = await this.dev.controlTransferIn({ requestType: "class", recipient: "interface", request: DFU.GETSTATUS, value: 0, index: this.iface }, 6);
    const b = new Uint8Array(r.data.buffer);
    return { status: b[0], timeout: b[1] | (b[2] << 8) | (b[3] << 16), state: b[4] };
  }
  out(request, value, data) { return this.dev.controlTransferOut({ requestType: "class", recipient: "interface", request, value, index: this.iface }, data); }

  async idle() {   // エラーや途中の状態を、待機(dfuIDLE)に戻す
    let s = await this.status();
    if (s.state === ST.dfuERROR) { await this.out(DFU.CLRSTATUS, 0); s = await this.status(); }
    if (s.state !== ST.dfuIDLE && s.state !== ST.appIDLE) { await this.out(DFU.ABORT, 0); s = await this.status(); }
  }

  async waitIdle() {   // 実行中の処理(消去・書き込み)が終わるまで
    let s = await this.status();
    while (s.state === ST.dfuDNBUSY) { await sleep(Math.max(s.timeout, 1)); s = await this.status(); }
    if (s.state === ST.dfuERROR || s.status !== 0) throw new Error(`DFU エラー(status ${s.status}, state ${s.state})`);
  }

  async command(code, addr) {   // 0x21 = アドレス設定、0x41 = ページ消去
    await this.out(DFU.DNLOAD, 0, Uint8Array.of(code, addr & 255, (addr >> 8) & 255, (addr >> 16) & 255, (addr >>> 24) & 255));
    await this.waitIdle();
  }

  async write(base, data, progress) {
    await this.idle();
    // 消去: 書く範囲にかかるページだけ
    const pages = pagesFor(this.sectors, base, data.length);
    if (!pages) throw new Error("このアドレス範囲はフラッシュの外です(0x08000000 から)");
    let n = 0;
    for (const p of pages) { await this.command(0x41, p); progress("erase", ++n / pages.length); }
    await this.command(0x21, base);
    for (let off = 0, blk = 2; off < data.length; off += this.xfer, blk++) {
      const chunk = data.subarray(off, Math.min(off + this.xfer, data.length));
      await this.out(DFU.DNLOAD, blk, chunk);
      await this.waitIdle();
      progress("write", Math.min(1, (off + chunk.length) / data.length));
    }
  }

  async leave(addr) {   // アドレスを設定して、長さ 0 の DNLOAD → 状態を読むと、プログラムへジャンプする
    await this.command(0x21, addr);
    await this.out(DFU.DNLOAD, 0, new Uint8Array(0));
    try { await this.status(); } catch {}   // この直後にデバイスが再接続するので、エラーは無視
  }
}

/** "@Internal Flash  /0x08000000/64*002Kg" → [{start, size, count}] */
export function parseLayout(s) {
  const m = /\/(0x[0-9a-fA-F]+)\/(.+)$/.exec(s || "");
  if (!m) return [];
  let start = parseInt(m[1], 16);
  const out = [];
  for (const part of m[2].split(",")) {
    const q = /(\d+)\*(\d+)\s*([KMB ])/i.exec(part.trim());
    if (!q) continue;
    const size = +q[2] * ({ K: 1024, M: 1048576, B: 1, " ": 1 }[q[3].toUpperCase()] || 1);
    out.push({ start, size, count: +q[1] });
    start += size * +q[1];
  }
  return out;
}

/** 書く範囲にかかるページの先頭アドレス。範囲外なら null。 */
export function pagesFor(sectors, base, len) {
  const pages = [], end = base + len;
  for (const s of sectors) for (let i = 0; i < s.count; i++) {
    const a = s.start + i * s.size;
    if (a < end && a + s.size > base) pages.push(a);
  }
  const last = sectors.length ? sectors[sectors.length - 1] : null;
  if (!last || end > last.start + last.size * last.count || base < sectors[0].start) return null;
  return pages;
}

export function dfuFlasher(repo) {
  return function mount(root) {
    const F = frame(root, {
      title: "STM32(BDCMD_X1)にファームウェアを書き込む — USB DFU",
      intro: `<ol style="margin:4px 0;padding-left:20px"><li><b>SW1 を押したまま</b> USB-C を PC につなぐ(電池をつないでいるときは、SW1 を押したまま電源を入れ直す)。新品のチップは、押さなくても DFU になります。</li>
        <li>「USB デバイスを選んで書き込む」を押し、<b>STM32 BOOTLOADER</b> を選ぶ。</li></ol>
        ファイルは <code>cd firmware && pio run</code> のあと <code>.pio/build/bdcmd_x1/firmware.bin</code>(USB 版は <code>bdcmd_x1_usb</code>)です。<code>0x08000000</code> から書きます。<br>
        <b>新しい基板に初めて書き込んだあとは、オプションバイトを一度だけ変更</b>してください(<code>nSWBOOT0 = 0</code>、<code>nBOOT0 = 1</code>)。この画面ではできません(bdcmd_x1 の hardware/README.md)。`,
      warn: "書き込むと、保存済みのパラメータと ID はコード上の値に戻ります。Linux では udev の権限、Windows では ST の DFU ドライバを WinUSB に替える(Zadig)必要があることがあります。",
    });
    let file = null;
    const name = el("span", { class: "small mute" }, "ファイル未選択");
    const set = (f) => { file = f; name.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB)`; };
    const pick = el("input", { type: "file", accept: ".bin", hidden: true });
    pick.onchange = () => { if (pick.files[0]) set(pick.files[0]); };
    const go = el("button", { type: "button", class: "pri" }, "USB デバイスを選んで書き込む");
    F.body.append(el("div", { class: "row" }, [el("button", { type: "button", onclick: () => pick.click() }, "firmware.bin を選ぶ"), pick, name]));
    builtinPicker(F.body, repo, [["同梱の firmware.bin を使う", ["firmware.bin"]]], set, F.log);
    releasePicker(F.body, repo, [".bin"], set, F.log);
    F.body.append(el("div", { class: "row" }, [go]));

    go.onclick = async () => {
      if (!navigator.usb) return F.log("このブラウザは WebUSB 非対応です(Chrome / Edge)", "err");
      if (!file) return F.log("firmware.bin を選んでください", "err");
      const u8 = new Uint8Array(await readBuf(file));
      const sp = (u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24)) >>> 0, reset = (u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24)) >>> 0;
      if (u8.length < 1024 || (sp >>> 20) !== 0x200 || (reset >>> 24) !== 0x08) return F.log("STM32 のファームウェア(.bin)に見えません(先頭のスタックポインタ / リセットベクタが不正)。ELF や HEX ではなく firmware.bin を選んでください", "err");
      if (!confirm(`${file.name}(${u8.length} バイト)を 0x08000000 から書き込みます。\nモーターは外す(または停止)しておいてください。続けますか?`)) return;
      go.disabled = true; F.progress(0);
      let dev;
      try {
        const usb = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x0483, productId: 0xdf11 }] });
        dev = new DfuSeDevice(usb);
        await dev.open();
        F.log(`接続: ${usb.productName || "STM32 BOOTLOADER"}、${dev.layout}、転送 ${dev.xfer} バイト`);
        await dev.write(0x08000000, u8, (ph, p) => { F.progress(ph === "erase" ? p * 20 : 20 + p * 80); });
        F.progress(100);
        F.log("書き込みが終わりました。プログラムを起動します…");
        await dev.leave(0x08000000);
        F.log("完了。USB を抜き差しして、STAT LED が点滅するか確認してください。");
      } catch (e) {
        F.log("失敗: " + (e.message || e), "err");
        if (/Access denied|SecurityError|claimInterface/i.test(String(e))) F.log("USB の権限がありません。Linux は udev ルール、Windows は WinUSB ドライバ(Zadig)が必要です", "err");
      } finally { try { await dev?.dev.close(); } catch {} go.disabled = false; }
    };
    return { destroy() {} };
  };
}

/** 書き込めない基板(HQDD1)の案内。 */
export function noFlash(msg) {
  return function mount(root) {
    const F = frame(root, { title: "ファームウェアの書き込み", intro: msg });
    F.$("prog").remove(); F.$("flog").remove();
    return { destroy() {} };
  };
}
