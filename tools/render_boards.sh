#!/usr/bin/env bash
# 基板画像を、同じフォルダ階層にある各基板リポジトリの KiCad ファイルから生成する。
# 使い方:  tools/render_boards.sh [リポジトリを並べたフォルダ(既定: このリポジトリの親)]
# 必要: kicad-cli (KiCad 8 以上)、Python の Pillow。実物の写真がある場合は static/img/boards/<id>.webp を置き換えればよい。
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/static/img/boards"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
render() { # id pcb
  local id="$1" pcb="$ROOT/$2"
  [ -f "$pcb" ] || { echo "skip $id: $pcb が無い" >&2; return; }
  kicad-cli pcb render --side top --quality basic --width 1600 --height 1200 \
    --background transparent -o "$TMP/$id.png" "$pcb" >/dev/null
  python3 - "$TMP/$id.png" "$OUT/$id.webp" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGBA")
im = im.crop(im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox())
im.thumbnail((900, 900))
im.save(sys.argv[2], "WEBP", quality=88)
PY
  echo "ok $id"
}
render hqdd1       hqdd1/hardware/hqdd_1.kicad_pcb
render bdcmd_x1    bdcmd_x1/hardware/BDCMD_X1.kicad_pcb
render main_board  main_board/hardware/main_board_ver2.0.kicad_pcb
render lds01_esp32 lds01_esp32/hardware/LDS01_ESP32.kicad_pcb
