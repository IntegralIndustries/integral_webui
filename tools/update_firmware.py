#!/usr/bin/env python3
"""各基板リポジトリの GitHub Actions(release.yml)が作った最新のビルド済みファームウェアを、
static/firmware/<基板>/ に取り込む。ブラウザの「ファームウェア書き込み」が、これを「内蔵」として選べる。

  gh auth login 済みの PC で:  python3 tools/update_firmware.py
  → static/firmware/ をコミットして push すれば、公開ページに反映される。

基板リポジトリ(private)の Actions の成果物を gh で取るので、リポジトリを読める権限が要る。
HQDD1 は USB で書けない(ST-Link)ので対象外。
"""
import json, pathlib, shutil, subprocess, sys, datetime

ORG = "IntegralIndustries"
BOARDS = ["main_board", "lds01_esp32", "bdcmd_x1"]
OUT = pathlib.Path(__file__).resolve().parent.parent / "static" / "firmware"


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


manifest = {}
for b in BOARDS:
    runs = json.loads(gh("run", "list", "-R", f"{ORG}/{b}", "-w", "release.yml", "-s", "success", "-L", "1",
                         "--json", "databaseId,headSha,createdAt"))
    if not runs:
        sys.exit(f"{b}: 成功したビルドがありません。{ORG}/{b} の Actions で「Build firmware」を実行してください")
    r = runs[0]
    d = OUT / b
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    gh("run", "download", str(r["databaseId"]), "-R", f"{ORG}/{b}", "-n", "firmware", "-D", str(d))
    files = sorted(p.name for p in d.iterdir() if p.suffix == ".bin")
    manifest[b] = {"files": files, "commit": r["headSha"][:7], "built": r["createdAt"], "run": r["databaseId"]}
    print(b, r["headSha"][:7], files)

OUT.mkdir(parents=True, exist_ok=True)
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
print("updated", datetime.datetime.now().isoformat(timespec="seconds"))
