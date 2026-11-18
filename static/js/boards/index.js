// 基板の一覧と、「基板情報」タブに出す説明(写真の番号、コネクタ、LED、はじめ方)。
// 内容は各基板リポジトリの README / docs / hardware の記述に基づく。変更があれば、ここを直す。
import hqdd1 from "./hqdd1.js";
import bdcmd_x1 from "./bdcmd_x1.js";
import main_board from "./main_board.js";
import lds01_esp32 from "./lds01_esp32.js";
import can_monitor from "./can_monitor.js";

const GH = "https://github.com/IntegralIndustries/";

export const BOARDS = [
  {
    id: "hqdd1", mod: hqdd1, name: "HQDD1", title: "HQDD1(QDD アクチュエータ)",
    tagline: "ジンバルモーター + 減速機を駆動する FOC 基板。トルク・速度・位置を制御し、PID をその場で調整できる。",
    tags: ["CAN", "UART"], links: ["can", "uart"], devId: true, repo: GH + "hqdd1",
    defaults: { baud: 115200 },
    specs: [["MCU", "STM32G431KB(128 KB flash)"], ["ドライバ", "DRV8311H(3 相、低サイド電流センス)"], ["角度センサ", "AS5600L(12 bit)"], ["通信", "CAN 1 Mbps(クラシック)/ UART 115200 bps"], ["モーター", "ジンバル 2204-260KV、減速比 29.16 または 5.4"], ["入力", "LiPo 2S(動作確認済み)/ 3S は実機未確認"]],
    photo: { src: "img/boards/hqdd1.webp", w: 900, h: 900, pins: [
      { n: 1, x: 72, y: 21, more: [[85.5, 28.5]] }, { n: 2, x: 10, y: 56 }, { n: 3, x: 12.5, y: 38 }, { n: 4, x: 49, y: 88 },
      { n: 5, x: 15.5, y: 69 }, { n: 6, x: 81, y: 81 }, { n: 7, x: 94.5, y: 50 }, { n: 8, x: 79, y: 53 }, { n: 9, x: 35.5, y: 22 }] },
    legend: [
      { n: 1, name: "CAN(2 か所)", detail: "CAN_H / CAN_L。2 か所は基板内でつながっていて、次の基板へつなぐデイジーチェーン用。1 Mbps(クラシック CAN)。バスの両端の基板で 120 Ω の終端が必要" },
      { n: 2, name: "UART(J3)", detail: "3.3 V TTL、115200 bps。USB-TTL の TXD → 基板 PA15(UART_TX)、RXD → 基板 PA2(UART_RX)。**GND は別に共通にする**(2 ピンだけで GND はない)" },
      { n: 3, name: "WRITE(J2、SWD)", detail: "書き込み用。ST-Link の SWDIO / SWCLK / GND をつなぐ(ST-Link は基板に載っていない)" },
      { n: 4, name: "電池(J1)", detail: "LiPo 2S(公称 7.4 V)で動作確認。3S(11.1 V)は電源電圧を 12 V に設定すれば使える想定だが未確認。− は左、+ は右" },
      { n: 5, name: "SET ID ボタン", detail: "2 秒長押しで ID 設定モード → 押した回数(1〜8)で ID(0〜7)を決める" },
      { n: 6, name: "LED(2 つ)", detail: "LED1(PA5)= ID を点滅回数で表示、LED0(PA4)= 負荷の表示。ID が重複していると LED0 が 2 回速く点滅 → 長い消灯" },
      { n: 7, name: "モーター A / B / C", detail: "ジンバルモーター(2204)の 3 相をつなぐパッド" },
      { n: 8, name: "DRV8311H", detail: "3 相モータードライバ(低サイド電流センス)" },
      { n: 9, name: "STM32G431KB", detail: "制御用マイコン" },
    ],
    steps: [
      "電池(2S)を基板の電池端子(J1)に、モーターを A / B / C につなぐ。",
      "CAN を使うとき: CAN アダプタを PC につなぎ、<code>sudo ip link set can0 up type can bitrate 1000000</code>。UART を使うとき: USB-TTL を J3 につなぐ。",
      "この画面の上のバーで<b>接続方法</b>と<b>ID</b>(「自動」でもよい)を選び、<b>接続</b>。",
      "「操作・設定」タブで、モードを選んで目標を送る。まず<b>速度モード・小さい値</b>から。Esc キーで停止。",
    ],
    notes: [
      { k: "w", html: "<b>初めて書き込む基板は、オプションバイトの修正が必要</b>です(しないと毎回ブートローダに入ります)。手順は hqdd1 リポジトリの README にあります。" },
      { k: "w", html: "<b>通信が途絶えても止まりません。</b>最後の指令のまま動き続けます。この画面を閉じるとき(接続を切るとき)は停止コマンドを自動で送ります。" },
      { k: "i", html: "プログラムを書き込み直すと、保存したパラメータと ID はコード上の値に戻ります。" },
      { k: "i", html: "この基板には USB がないため、書き込みは ST-Link(SWD)で行います(ブラウザからは書き込めません)。" },
    ],
  },
  {
    id: "bdcmd_x1", mod: bdcmd_x1, name: "BDCMD_X1", title: "BDCMD_X1(4ch ブラシモータードライバ)",
    tagline: "ブラシモーターを 4 つ駆動。ch ごとにデューティ・速度・位置の制御を選べる。",
    tags: ["CAN", "UART", "USB"], links: ["can", "uart"], devId: true, repo: GH + "bdcmd_x1",
    defaults: { baud: 115200 },
    specs: [["MCU", "STM32G431CBT6(170 MHz)"], ["ドライバ", "DRV8874 × 4(電流検出・電流制限つき)"], ["出力", "連続 約 2 A(4ch 同時)/ 約 3 A(1ch)、最大 6 A"], ["エンコーダ", "AS5600 × 4(PH 4 ピン、3V3 / GND / SDA / SCL)"], ["通信", "CAN 1 Mbps / UART 115200 bps / USB-C"], ["入力", "LiPo 2S〜3S(部品交換で 6S)、XT30"]],
    photo: { src: "img/boards/bdcmd_x1.webp", w: 596, h: 900, pins: [
      { n: 1, x: 25, y: 4, more: [[32, 4]] }, { n: 2, x: 23.5, y: 12.5 }, { n: 3, x: 49, y: 4 }, { n: 4, x: 66, y: 4, more: [[61, 16.5]] },
      { n: 5, x: 91.5, y: 12.8 }, { n: 6, x: 75.5, y: 12.2 },
      { n: 7, x: 5.5, y: 29.5, more: [[93.5, 30.5], [5.5, 70.5], [93.5, 73.5]] }, { n: 8, x: 16, y: 46.5, more: [[16, 55], [84, 47.8], [84, 55]] },
      { n: 9, x: 58, y: 84 }, { n: 10, x: 25, y: 94 }] },
    legend: [
      { n: 1, name: "CAN(J3、J4)", detail: "ZH 2 ピン × 2(デイジーチェーン)。1 Mbps。**GND ピンはない**ので、基板どうしの GND は電源配線で共通に" },
      { n: 2, name: "TERM(JP1)", detail: "120 Ω 終端のジャンパ。バスの両端の基板だけ ON(ピンにジャンパを付ける)" },
      { n: 3, name: "SWD(J6)", detail: "ZH 4 ピン: 1 = 3V3、2 = SWDIO、3 = SWCLK、4 = GND。ST-Link は通常接続(Connect under reset ではなく)で" },
      { n: 4, name: "UART(J5 / J7)", detail: "J5 = PH 3 ピン(1 GND、2 RX、3 TX)、J7 = ZH 2 ピン(1 TX、2 RX)。どちらも同じ USART1。3.3 V、115200 bps" },
      { n: 5, name: "SW1(ID / DFU)", detail: "2 秒長押しして離す → 押した回数(1〜8)= ID + 1。USB でつなぐ前に押したままにすると DFU(書き込みモード)" },
      { n: 6, name: "STAT / ERR LED", detail: "STAT = ID + 1 回点滅を繰り返す。ERR = 異常の表示(点灯 = FAULT/低電圧、速い点滅 = 非常停止、2 回速く点滅 = ID 重複)" },
      { n: 7, name: "モーター M1〜M4", detail: "表面のパッド(穴なし、5 × 4 mm)に上からはんだ付け。M2 / M4 は M1 / M3 と回転方向が逆(左右に向かい合わせると同じ指令で同じ向きに進む)。脇の LED は出力の向きと強さ(緑 / 赤)" },
      { n: 8, name: "エンコーダ ENC1〜4", detail: "PH 4 ピン: 1 = 3V3、2 = GND、3 = SDA、4 = SCL。AS5600 など。ch と同じ番号が既定(<code>EN</code> パラメータで変更可)" },
      { n: 9, name: "電池(XT30)", detail: "LiPo 2S〜3S。1 番 = GND、2 番 = +BATT(main_board と同じ)。6S は D1 と LED 抵抗を交換" },
      { n: 10, name: "USB-C", detail: "書き込み(DFU)と、電池なしでの通信・エンコーダ・CAN の確認。電池がないとモーターは動かない" },
    ],
    steps: [
      "電池を XT30 に、モーターを M1〜M4 のパッドに、エンコーダ(使うなら)を ENC1〜4 につなぐ。",
      "CAN(J3 / J4)か UART(J5 / J7)を PC につなぐ。CAN は <code>sudo ip link set can0 up type can bitrate 1000000</code>。",
      "上のバーで接続方法と ID(SW1 で設定、または「自動」)を選んで<b>接続</b>。",
      "各 ch のカードで<b>デューティモード</b>(エンコーダ不要)から試す。速度・位置モードは、エンコーダの向きと減速比(<code>ED</code>、<code>GR</code>)を合わせてから。",
    ],
    notes: [
      { k: "w", html: "<b>通信タイムアウト(既定 500 ms)</b>: 動作の指令が途切れると全 ch が止まります。この画面は、指令した目標を 200 ms ごとに送り続けます(左の「通信タイムアウト対策」で切れます)。" },
      { k: "w", html: "<b>低電圧の停止(<code>LV</code>)は既定で無効</b>です。LiPo を使うときは設定してください(2S なら 6.6 V が目安)。" },
      { k: "w", html: "<b>ゲインの出荷値は仮の値</b>です。モーターに合わせて調整してください。" },
      { k: "i", html: "初めて書き込むときは、オプションバイト(<code>nSWBOOT0 = 0</code>、<code>nBOOT0 = 1</code>)を一度だけ変更します。bdcmd_x1 の hardware/README.md を参照。" },
    ],
  },
  {
    id: "main_board", mod: main_board, name: "main_board", title: "main_board(メイン制御基板 ver2.0)",
    tagline: "PS4 や PC から操縦指令を受けて、足回りを計算し、BDCMD・HQDD・ESC・サーボに配る司令塔。",
    tags: ["Wi-Fi", "USB", "CAN", "PS4"], links: ["udp", "uart"], devId: false, repo: GH + "main_board",
    defaults: { baud: 115200, host: "integral-main.local", udpPort: 9100 },
    specs: [["MCU", "ESP32-WROOM-32E(Wi-Fi / Bluetooth)"], ["入力", "LiPo 2S〜3S(XT30)/ USB-C(ロジックのみ)"], ["出力", "ESC × 4、サーボ × 2、ブラシモーター × 2"], ["センサ", "エンコーダ × 7(I2C マルチプレクサ)、IMU × 1"], ["通信", "CAN 1 Mbps、UART2、USB(CH340K)、Wi-Fi UDP 9100"], ["足回り", "メカナム 4 輪 / オムニ 3・4 輪 / 独立ステア 3・4 輪"]],
    photo: { src: "img/boards/main_board.webp", w: 680, h: 900, pins: [
      { n: 1, x: 3.5, y: 14.5, more: [[3.5, 21.8]] }, { n: 2, x: 13, y: 15.5 }, { n: 3, x: 5.5, y: 33, more: [[5.5, 49], [5.5, 63], [5.5, 78], [17, 33], [17, 49], [17, 63]] }, { n: 4, x: 17, y: 78 },
      { n: 5, x: 74, y: 7.5 }, { n: 6, x: 85, y: 15.5 }, { n: 7, x: 95, y: 10.5, more: [[95, 26], [95, 38], [95, 50.5]] }, { n: 8, x: 95, y: 63, more: [[95, 75.5]] },
      { n: 9, x: 80, y: 66, more: [[80, 77.5]] }, { n: 10, x: 54.5, y: 84 }, { n: 11, x: 30, y: 95.5 }, { n: 12, x: 56, y: 33, more: [[62, 33], [62, 37]] }, { n: 13, x: 49.5, y: 39, more: [[49.5, 43]] }, { n: 14, x: 44, y: 17 }, { n: 15, x: 74.5, y: 17.5, more: [[74.5, 27.5]] }] },
    legend: [
      { n: 1, name: "CAN × 2(J12、J13)", detail: "JST ZH 2 ピン(1 = CAN_H、2 = CAN_L)。基板内で並列(デイジーチェーン)。**GND ピンなし**" },
      { n: 2, name: "TERM(J24)", detail: "ジャンパを付けると 120 Ω 終端。バスの両端の基板だけ" },
      { n: 3, name: "エンコーダ ENC1〜7(7 か所)", detail: "JST PH 4 ピン(1 = 3V3、2 = GND、3 = SDA、4 = SCL)。I2C マルチプレクサ経由なので、同じアドレスのセンサ(AS5600 など)も同時に使える" },
      { n: 4, name: "IMU(J23)", detail: "PH 5 ピン(3V3 / GND / SDA / SCL / INT)。MPU-6050 など" },
      { n: 5, name: "UART2(J9)", detail: "PH 2 ピン(1 = RX、2 = TX)、3.3 V。Raspberry Pi などをつなぐ。GND ピンなし" },
      { n: 6, name: "UART1(J25)", detail: "予備の書き込み口(ESP32 の UART0)。USB から書き込めないとき用" },
      { n: 7, name: "ESC1〜4(J5〜J8)", detail: "PH 3 ピン(1 = GND、2 = 中央、3 = 信号 5 V)。中央ピンは通常未接続(BEC なしの ESC だけ、はんだジャンパで +5V にする。**BEC 付きでは閉じない**)" },
      { n: 8, name: "サーボ SERVO1・2(J3、J4)", detail: "PH 3 ピン(1 = GND、2 = +5V、3 = 信号)" },
      { n: 9, name: "モーター M1・M2(J16、J17)", detail: "XA 2 ピン、一方向の PWM。M1 は +5V、M2 は電池電圧。各 3 A 目安" },
      { n: 10, name: "電池(XT30)", detail: "LiPo 2S〜3S(6〜12.6 V)。**4S 以上は不可**。逆接続保護・ヒューズなし(XT30 の形状で防ぐ)" },
      { n: 11, name: "USB-C", detail: "書き込みとシリアル通信(CH340K、115200 bps)。USB だけだとロジック部のみ給電(サーボ・ESC・モーターは動かない)" },
      { n: 12, name: "EN / BOOT / USER スイッチ", detail: "EN = リセット、BOOT = 押しながらリセットで書き込みモード、USER(SW3)= 短押しで足回り有効/無効・解除、**2 秒長押しで非常停止**" },
      { n: 13, name: "LED", detail: "LED1(IO14): 点灯 = 足回り有効、ゆっくり点滅 = 無効、速い点滅 = 非常停止。LED2(IO2): 点灯 = PS4 接続中、短い点滅 = Wi-Fi 接続中" },
      { n: 14, name: "ESP32 モジュール", detail: "アンテナ部は基板の外にはみ出す配置。周囲に金属を近づけない" },
      { n: 15, name: "TX × 2(J10、J11)", detail: "PH 2 ピン(1 = GND、2 = TX)。UART2 の TXD と同じ信号。電圧は JP6(はんだジャンパ)で 3.3 V / 5 V を選ぶ(どちらか一方だけつなぐ)" },
    ],
    steps: [
      "電池(2S〜3S)を XT30 に。ロジックだけ試すなら USB-C でもよい。",
      "<b>USB で試す</b>: USB-C を PC につなぎ、この画面で接続方法「USB シリアル」を選んで接続(Chrome / Edge ならサーバ不要)。",
      "<b>Wi-Fi で試す</b>: 先に USB でつないで、画面の「Wi-Fi 設定」に SSID とパスワードを入れて保存(基板に残ります。<code>config/secrets.h</code> を書いてビルドしてもよい)。そのあと接続方法「Wi-Fi (UDP)」(<code>server.py</code> が必要)。ホスト名は <code>integral-main.local</code>、つながらなければ IP アドレス。",
      "「足回り」の<b>有効 (D 1)</b> を押し、円を押している間だけ動く。まずは車輪を浮かせて、小さい速度で。",
    ],
    notes: [
      { k: "w", html: "<b>足回りは起動時は無効</b>です。PC の <code>D 1</code>、PS4 の OPTIONS、USER スイッチの短押しのどれかで有効にします。" },
      { k: "w", html: "<b>PS4 が優先</b>です。PS4 がつながっている間は PC の速度指令(<code>V</code>)は無視されます。" },
      { k: "i", html: "足回りの種類、各輪をどの基板で動かすかは<b>ビルド時の設定</b>(<code>config/robot_config.h</code>)です。画面の「robot_config.h 作成」タブで作れます。" },
    ],
  },
  {
    id: "lds01_esp32", mod: lds01_esp32, name: "LDS01_ESP32", title: "LDS01_ESP32(LiDAR の Wi-Fi 送信基板)",
    tagline: "LiDAR(LDS-01)の 360° 距離を Wi-Fi で PC(ROS 2 の /scan)へ。8 方向の最短距離は CAN と UART にも出す。",
    tags: ["Wi-Fi", "CAN", "UART"], links: ["udp", "uart", "can"], devId: true, repo: GH + "lds01_esp32",
    defaults: { baud: 115200, host: "integral-lds.local", udpPort: 9200 },
    specs: [["MCU", "ESP32 DevKit(ELEGOO 30 ピン、ソケットに差す)"], ["センサ", "LDS-01(360°、1° 刻み、0.12〜3.5 m、約 5 回転 / 秒)"], ["送信", "Wi-Fi UDP(1 回転 = 1 パケット)→ ROS 2 の /scan"], ["CAN / UART", "8 方向の最短距離を 10 Hz(CAN 1 Mbps、UART 115200 bps)"], ["入力", "LiPo 2S〜3S(XT30)→ 5 V 2 A"], ["基板", "31 × 45.6 mm、2 層"]],
    photo: { src: "img/boards/lds01_esp32.webp", w: 612, h: 900, pins: [
      { n: 1, x: 26, y: 14 }, { n: 2, x: 52, y: 14 }, { n: 3, x: 35.5, y: 74 }, { n: 4, x: 78.5, y: 87 }, { n: 5, x: 72, y: 67 },
      { n: 6, x: 6.5, y: 42, more: [[89, 42]] }, { n: 7, x: 96.5, y: 50.5, more: [[96.5, 65.5]] }] },
    legend: [
      { n: 1, name: "UART(J6)", detail: "PH 3 ピン(1 = GND、2 = RX、3 = TX)、3.3 V、115200 bps。8 方向の最短距離を 10 Hz のテキストで出す。コマンド(<code>START</code> / <code>STOP</code> / <code>?</code>)も受ける" },
      { n: 2, name: "CAN(J4)", detail: "PH 2 ピン(1 = H、2 = L)。**120 Ω 終端が常時つながっている**ので、バスの端に置く(途中に置くなら R8 を外す)。GND ピンなし。**CAN FD は不可**(classic CAN のみ)" },
      { n: 3, name: "電池(XT30)", detail: "LiPo 2S〜3S → AP63205 で 5 V(LDS・ESP32 に供給)" },
      { n: 4, name: "LDS-01 コネクタ(J2)", detail: "PicoBlade 8 ピン。LDS-01 をつなぐ(UART 230400 bps)" },
      { n: 5, name: "J3(LDS-01 の直付け用パッド)", detail: "J2 の代わりに線を直接はんだ付けする穴(2.0 mm ピッチ)。J2 と同じ並び" },
      { n: 6, name: "ESP32 DevKit のソケット", detail: "30 ピンの ESP32 DevKit を差す(列の間隔 25.4 mm)。アンテナ側のケーブルは、すぐ下に曲げてアンテナから離す" },
      { n: 7, name: "STAT / PWR LED", detail: "PWR = 電源。STAT: 消灯 = LDS のデータなし、ゆっくり点滅 = LDS は動いているが PC へ送っていない、点灯 = PC へ送信中、2 回速く点滅 = CAN の ID 重複" },
    ],
    steps: [
      "<code>firmware/src/secrets.example.h</code> を <code>secrets.h</code> にコピーして SSID とパスワードを書き、<code>pio run -t upload</code>。",
      "LDS-01 と電池をつなぐ。STAT LED がゆっくり点滅すれば LDS は動いている。",
      "この画面で接続方法「Wi-Fi (UDP)」を選び、ホスト <code>integral-lds.local</code>(名前で引けなければ IP アドレス)で<b>接続</b>。STAT LED が点灯に変わり、点群が表示される。",
      "CAN の ID は、ファームの <code>config.h</code>(<code>LDS_BOARD_ID</code>)で決める(「config.h 作成」タブ)。基板にボタンはない。",
    ],
    notes: [
      { k: "i", html: "UDP は、この画面が <code>SUB</code> を 1 秒ごとに送っている間だけ届きます(3 秒途切れると基板は送るのをやめます)。ブラウザからは直接 UDP を使えないので、<code>server.py</code> が中継します。" },
      { k: "i", html: "ROS 2 で使うときは lds01_esp32 リポジトリの <code>ros2/</code>(UDP → /scan のノード)を使います。この画面は、配線や LDS の動作確認用です。" },
    ],
  },
  {
    id: "can_monitor", mod: can_monitor, name: "全基板(CAN バス)", title: "全基板 — CAN バスモニター",
    tagline: "どの基板が、何番の ID でバスにいるか調べる。非常停止も全基板へ。基板がどれか分からないときはここから。",
    tags: ["CAN"], links: ["can"], devId: false, monitor: true, repo: GH + "main_board",
    defaults: {},
    specs: [["見えるもの", "HQDD1 / BDCMD_X1 / LDS01_ESP32 / main_board の CAN フレーム"], ["使い方", "CAN アダプタをつないで「接続」を押すだけ(受信だけ。何も送らない)"]],
    photo: null, legend: [], steps: [
      "CAN アダプタを PC につなぎ、<code>sudo ip link set can0 up type can bitrate 1000000</code>。",
      "<b>接続</b>を押すと、バスにいる基板が一覧に出る。ID 重複(同じ ID が 2 台)は BDCMD_X1 の状態フラグで分かる。",
    ],
    notes: [{ k: "i", html: "CAN の ID の割り当て表は、main_board リポジトリの <code>docs/can_id_map.md</code> が原本です。" }],
  },
];

export const byId = (id) => BOARDS.find((b) => b.id === id);
