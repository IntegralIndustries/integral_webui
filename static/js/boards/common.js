// 基板の画面で共通の処理。
import { banner, sleep } from "../ui.js";

/**
 * 同じ UART バスに複数台がいても、見たい 1 台のテレメトリだけにする(HQDD1 / BDCMD_X1 共通の約束)。
 * 全台を黙らせて(@* T0)から対象だけ有効にする(@<ID> T1)。
 */
export async function uartSelect(tr, id) {
  tr.sendLine("@* T0");
  await sleep(50);
  tr.sendLine(`@${id} T1`);
}

/**
 * UART の「ID 自動」。基板が流す "#<id> ..." の行から、最初に見えた ID を使う。
 * 戻り値の observe(id) を、行を受け取るたびに呼ぶ。
 */
export function uartAutoDetector({ tr, ctx, log, onDetected }) {
  const seen = new Set();
  return {
    observe: (id) => seen.add(id),
    async run() {
      seen.clear();
      for (let phase = 0; phase < 2 && tr.connected && !seen.size; phase++) {
        if (phase === 1) tr.sendLine("@* T1");   // 前回のセッションで黙らせた基板を起こす
        await sleep(1500);
      }
      if (!tr.connected) return;
      if (!seen.size) return banner("基板のIDを検出できません(データが届いていません)。配線・baud・IDを確認してください");
      const ids = [...seen].sort((a, b) => a - b);
      if (ids.length > 1) banner(`複数の基板を検出: ID ${ids.join(", ")}。最小のID ${ids[0]} を使います。変える場合はIDを選んで接続し直してください`, "info");
      ctx.setDevId(ids[0]);
      log.add(`IDを自動検出: ${ids[0]}`);
      await uartSelect(tr, ids[0]);
      onDetected(ids[0]);
    },
  };
}
