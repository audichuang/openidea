---
name: openidea-fork-auto-rebase
description: Unattended pipeline that rebases the OpenIDEA fork's develop onto the newest upstream release, runs the local gates and Fork CI, then moves develop and releases when the rebase was CLEAN or MECHANICAL, or leaves a PR for the user. Use when the "OpenIDEA fork 自動 rebase" Orca automation fires, or when the user asks to run or resume that pipeline.
---

# OpenIDEA fork 自動 rebase

無人值守：沒有人會回答問題，不要停下來問。repo 是 audichuang/openidea（remote `fork`），上游 l0ng-ai/openidea（remote `origin`）。規則來源是 `git show fork/develop:FORK.md`，先讀全文；這裡沒寫的照它，名詞（CLEAN、MECHANICAL、MANUAL、rebase 鎖）照它的定義。

## 範圍

只做一件事：把 develop 搬到上游最新 release，閘門全過而且是 CLEAN 或 MECHANICAL 就移動 develop 並發版。MANUAL 的照樣盡力解完、跑完閘門，但不移動 develop，留 PR 給使用者。慢沒關係；做不下去就停下來交人，不要為了發版硬修。

不處理，只列進第 7 步通知：這次沒碰到的既有問題、功能改進與重構、實機 UI 測試。

變數：`SKILL_DIR`＝本檔所在目錄；`MAIN`＝Orca 為這次 run 開的 worktree（開頭 `pwd -P` 記下）；`RUN`＝`date -u +%Y%m%dT%H%M%SZ`，開頭記一次，暫時 worktree 一律叫 `../ar-$RUN-<名字>`；`vNEW`、`vOLD`、`OLD_DEVELOP`、`PR` 在第 0 步定義。寫進指令時代換成實際值；shell 變數後面緊接 `:` 一律寫 `${OLD_DEVELOP}:`（zsh 修飾符）。

PR 留言的標記（`<!-- auto-rebase:… -->`）一律放在留言第一行最前面：precheck 只認開頭的標記。

## 0. 決定模式

```sh
git fetch fork --tags && git fetch origin --no-tags '+refs/tags/v*:refs/tags/v*' && git fetch origin main
```

- vNEW＝`gh api repos/l0ng-ai/openidea/releases/latest --jq .tag_name`（須符合 `^v[0-9]+\.[0-9]+\.[0-9]+$`）。
- vOLD＝`git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-fork*' fork/develop`。
- 鎖用 `git ls-remote fork 'refs/heads/rebase/*'` 判斷。有 `rebase/vX`：
  - PR 開著、有 `<!-- auto-rebase:develop-moved <sha> -->` 留言（前一次 run 移動 develop 後、發版途中死了）→ vNEW=vX、PR=那個 PR，直接做第 6 步，發的是留言裡的 sha；vOLD 與 OLD_DEVELOP 取 PR 說明。
  - PR 開著、沒有 develop-moved、**最後一則** `<!-- auto-rebase:approved <sha> -->` 留言排在最後一則 needs-human 之後、sha 等於 `git rev-parse fork/rebase/vX`（使用者看過 needs-human 的 PR 後核可；和 precheck 同一個定義。sha 不等代表核可後又推過；排在 needs-human 之前代表之前的 run 已拒絕它。兩者都是核可作廢，照下一條處理）→ vNEW=vX、PR=那個 PR，vOLD 與 OLD_DEVELOP 取 PR 說明。先確認 Fork CI 在這個 sha 上 `Fork CI passed` 成功，或紅的 job 都已在 PR 說明列為上游在 vX 也紅（第 3 步的規則）；不符就 PR 留言 `<!-- auto-rebase:needs-human -->` 說明哪裡不符，跳第 7 步。都符合就 `git checkout --detach <sha>`，從第 4 步「移動」做起（不重跑 rebase 與閘門），接著第 5、6 步。
  - PR 開著、有 `<!-- auto-rebase:needs-human -->` 留言、沒有符合上一條的 approved（precheck 只在它過時才讓你跑到這：上游出了更新的 release，或 develop 已經在 vX）→ **收鎖**：`rebase/vX` 的 tip 不在 `fork/develop` 或 `fork/backup/*` 上就先 `git push fork "fork/rebase/vX:refs/heads/backup/rebase-vX-$RUN"`；PR 留言說明原因後 `gh pr close`，刪 fork 的 `rebase/vX` 與 `ci-base/vX`。然後重新判斷：vNEW == vOLD 就結束、不推通知；否則 NEW。
  - 其他（precheck 判定鎖過期：前一次 run 死了）→ 同樣先備份不在 develop／backup 上的 tip、關 PR（有的話）、刪兩條分支，當 NEW 從頭來。不續跑半途的 rebase：從頭重來比較可靠。
- 沒有 `rebase/*` 且 vNEW == vOLD → 結束，不推通知。
- 否則 **NEW**：`OLD_DEVELOP=$(git rev-parse fork/develop)`。

開始前清掉之前 run 留下的 worktree：`git worktree list` 裡路徑含 `auto-openidea-fork-rebase` 而且不是 `MAIN` 的、目錄名以 `ar-` 開頭但 `$RUN` 不是這次的，只在 `git -C <路徑> status --porcelain -- . ':!.rebase-review'` 沒輸出（`.rebase-review/` 是每次 run 自己寫的，notes 已進 tag 說明，不算）、不在 rebase 中、`git -C <路徑> branch -r --contains HEAD` 列得出 `fork/` 分支時刪（Orca 開的用 `orca worktree rm --worktree "id:38d295e1-a1dd-4eea-871a-5bbe1bef2554::<路徑>" --force --json`，其他用 `git worktree remove --force`），刪完再 `git branch -D` 它原本所在的 `audichuang/auto-openidea-fork-rebase-run-*` 本地分支（有的話）；其餘列進通知。

一律在 `MAIN` 做，不動 `~/Project/openidea` 主 checkout。全程 detached HEAD，推送寫明目的地（`git push fork HEAD:refs/heads/rebase/vNEW`）。

## 1. Rebase

1. 先上鎖再動手，不然解衝突超過一小時，下一次排程會再開一輪：
   ```sh
   lock=$(git commit-tree "${OLD_DEVELOP}^{tree}" -p "${OLD_DEVELOP}" -m "auto-rebase lock vNEW")
   git push fork "${lock}:refs/heads/rebase/vNEW"
   ```
   之後每次推 `rebase/vNEW` 都用 `--force`。Fork CI 看到這個訊息開頭的 commit 會跳過。
2. `git config rerere.enabled true`，`git checkout --detach OLD_DEVELOP`。上游基底取 `UPSTREAM_BASE=$(git merge-base OLD_DEVELOP origin/main)`（develop 可能停在 release 之後的上游 commit，用 vOLD 當基底會把那幾個上游 commit 當成 fork commit 重放）。
3. `GIT_EDITOR=true git rebase --onto vNEW "$UPSTREAM_BASE"`，單獨跑、看結束碼（不要接 `| tail`）。每次停在衝突，對每個衝突檔照 FORK.md「Rebase conflicts」分類：
   - locale JSON → `python3 scripts/fork/resolve-conflicts.py locale <檔>`
   - 兩邊都在檔尾加東西的測試檔 → `python3 scripts/fork/resolve-conflicts.py append <檔>`
   - `Cargo.lock`、`pnpm-lock.yaml`、`src/bindings.ts` → `git checkout --ours -- <檔>`（rebase 時 ours 是上游），第 4 點重新產生
   - 腳本拒絕（exit 1）或其他任何檔 → MANUAL：保留 fork 功能、採上游新結構自己解；沒把握就 `git rebase --abort`，鎖留著，跳到第 7 步（開 PR、標 needs-human）。

   腳本已經 `git checkout --conflict=diff3`（rerere 重放過的也會被重建後重解）；解完 `git add <檔>`、`GIT_EDITOR=true git rebase --continue`。把每個衝突檔、它的類別與 commit 記進 `$MAIN/.rebase-review/conflicts.txt`，PR 說明要用。

4. rebase 完重新產生生成檔（在 Mac mini 上 Rust 一律走 `rust-remote`）：`pnpm install --lockfile-only`；`rust-remote --pull Cargo.lock metadata --format-version 1 > /dev/null`。有差異就一個 commit `chore(fork): 重新產生 lockfile`（MECHANICAL）。`src/bindings.ts` 不在這裡重新產生：維持上游那邊，由第 3 步 Fork CI 的 `Bindings are up to date` 檢查。
5. 模式：沒有衝突、第 4 點沒產生 commit → CLEAN；只有前三類衝突與第 4 點的 commit → MECHANICAL；其餘（自己解的衝突、任何修正 commit）→ MANUAL。
6. `git push --force fork HEAD:refs/heads/rebase/vNEW`，`git push fork "vNEW^{commit}:refs/heads/ci-base/vNEW"`，開 PR：`gh pr create -R audichuang/openidea --base ci-base/vNEW --head rebase/vNEW --title "[不合併] develop rebase 到 vNEW 的驗證"`，記下 `PR`。body 第一行 `<!-- auto-rebase:old-develop OLD_DEVELOP 的完整 sha -->`，其餘寫：為什麼不合併（develop 由 lease 推送移動）、`develop = vOLD(+上游 commit) + N 個 fork commit → vNEW + …`、模式、每個衝突檔的類別與解法、額外 commit。不加任何 attribution 行。

你寫的 commit：message 繁體中文，不加 Co-Authored-By 或任何 attribution 行。

## 2. 本機閘門

先在 PR 留言「本機閘門開始」（心跳）。`pnpm install --frozen-lockfile && mkdir -p dist`，然後各自跑、全部跑完再看結果：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm knip`、`pnpm test`；`rust-remote fmt --all --check`、`rust-remote clippy --workspace --all-targets -- -D warnings`、`rust-remote nextest run --workspace --profile ubuntu-remote --no-fail-fast`（profile 已排除 ubuntu 上必失敗的環境性測試）。

失敗要拿上游對照：`git worktree add --detach ../ar-$RUN-base vNEW`，在那裡跑同一條指令（Rust 一樣走 `rust-remote`，它在遠端用目錄名分開）。兩邊都紅的是上游或環境的（例如遠端主機沒有先編 sample plugin 的 wasm），兩份輸出尾段都貼進 PR 說明；只有 fork 紅的是 fork 造成的，要修（修正 commit 讓模式變 MANUAL）。同一個問題修兩輪還不過 → 第 7 步交人。

## 3. Fork CI

`git push --force fork HEAD:refs/heads/rebase/vNEW` 觸發 Fork CI（`fork-ci.yml` 對 `rebase/**` 的 push 也會跑）。用 `gh run list -R audichuang/openidea --workflow fork-ci.yml --branch rebase/vNEW --json databaseId,headSha` 找 `headSha` 等於 HEAD 的 run，`gh-wait run <id> -R audichuang/openidea` 等它（不用 `gh run watch`、不輪詢）。

結果看 `Fork CI passed` 這個 job。Linux Rust job 停在 `Bindings are up to date`，代表 fork 的 IPC 型別要重新產生 bindings：不修、不重跑，模式改成 MANUAL，needs-human 留言寫明要用 `rust-remote --pull src/bindings.ts test -p openidea --test export_bindings` 重新產生 `src/bindings.ts`（見 FORK.md）、推上 `rebase/vNEW`，等 CI 綠了再核可新的 sha。`Upstream ci.yml unchanged` 紅了代表上游改了 `ci.yml`：照 FORK.md 把改動移植進 `fork-ci.yml` 並更新 pin（修正 commit，模式變 MANUAL）。其他紅的 job 先 `gh run rerun <id> --failed` 一次；再紅就看上游同一個 job 在 vNEW 是否也紅：`gh run list -R l0ng-ai/openidea --workflow ci.yml --commit $(git rev-parse 'vNEW^{commit}')`。上游也紅 → 不擋（PR 說明附兩邊的 run 連結）；上游綠或沒有可比的 run → fork 造成的，照第 2 步的規則修，修完回到第 3 步。

## 4. 移動 develop

條件全部成立才移動：模式是 CLEAN 或 MECHANICAL、第 2 步沒有 fork 造成的紅、第 3 步 CI 綠（或只剩上游也紅的 job）。從第 0 步 approved 進來的，使用者的核可取代模式條件。

`git rev-parse fork/develop` 已經等於 HEAD（使用者自己移過，或前一次 run 推完還沒留言就死了）→ 不推，直接留 develop-moved 留言。否則：

```sh
git push --force-with-lease=develop:OLD_DEVELOP fork HEAD:develop
```

lease 失敗（develop 在這期間合進了別的 PR）→ HEAD 不在 `fork/develop` 或 `fork/backup/*` 上就先 `git push fork "HEAD:refs/heads/backup/rebase-vNEW-$RUN"`（從 approved 進來的 HEAD 含使用者審過的解法），再 PR 留言說明後關閉、刪 `rebase/vNEW` 與 `ci-base/vNEW`，通知「下一次 run 從新的 develop 重來」，結束。成功 → PR 留言 `<!-- auto-rebase:develop-moved <HEAD 完整 sha> -->`。

develop 一移動（含已在 HEAD 不重推的情況）就 `gh workflow list -R audichuang/openidea --all`：state 是 active、名稱不是 `Fork CI`／`Fork Release` 的，是這次 rebase 帶進來的上游 workflow，照 FORK.md 馬上 `gh workflow disable`，寫進通知。`pull_request_target` 從 PR 的 base 分支讀 workflow，develop 一動，下一個對 develop 開的 PR 就會觸發它（v0.1.35 的 `PR check` 幾秒內就在 PR 上貼了 needs-info）。清單裡還沒出現的，第 6 步移動 main 後再查一次。接第 5 步。

不符合條件（MANUAL，或有修不掉的紅）→ 不移動，PR 留言 `<!-- auto-rebase:needs-human -->` 加上要使用者看什麼，最後一段固定寫交回方法：看完沒問題就另留一則第一行是 `<!-- auto-rebase:approved <HEAD 完整 sha> -->` 的留言，下一次排程（每小時 :37）會移動 develop 並發版。不要給使用者手動 lease 推送或發版的指令。跳第 7 步。

## 5. 對 develop 開著的 PR

`gh pr list -R audichuang/openidea --base develop --state open`：每個 PR 的分支都還在舊基底上，留言請它照 FORK.md 用 `git rebase --onto fork/develop <舊 merge-base>` 搬過來。不要替它搬。

## 6. 發版

1. 先查要發的 sha 是否已有 tag：`git ls-remote --tags fork "refs/tags/vNEW-fork.*"` 裡有指向它的（annotated tag 看 `^{}` 那行），代表前一次 run 推完 tag 後死了：沿用那個 tag，跳到第 4 點看它的 fork-release run（失敗就 `gh run rerun <id>`；找不到 run 就寫進通知交人，fork-release 只由推 tag 觸發），不要再發新 N。沒有才算 N：最大的 N 加一，沒有就 1。
2. 寫 release notes（繁體中文，使用者看得到的變化；不寫 commit 雜訊）存成 `$MAIN/.rebase-review/notes.md`：
   - 第一行：`基於上游 vNEW（上一版基於 vOLD）`
   - 上游這次的重點：讀 `gh release view <tag> -R l0ng-ai/openidea --json body` 裡 vOLD 之後到 vNEW 的每一版，挑使用者看得到的改動，每項一行
   - fork 這次的改動：拿 `git log --format=%s vNEW..HEAD` 和上一個 fork release tag 的 `git log --format=%s <它的上游基底>..<tag>` 比，標題是新的才列；都沒有就寫「fork 功能無變更，只跟上上游」
   - 這次 rebase 的模式與衝突一句話
3. 移動 main 並推 annotated tag，同一次推送：
   ```sh
   old=$(git ls-remote fork refs/heads/main | cut -f1)
   git tag -a vNEW-fork.N <develop-moved 的 sha> -F "$MAIN/.rebase-review/notes.md"
   git push --atomic --force-with-lease=main:$old fork <sha>:refs/heads/main vNEW-fork.N
   ```
   推完再跑一次第 4 步的 `gh workflow list` 檢查，有新出現的 active 上游 workflow 就 disable。
4. `gh run list -R audichuang/openidea --workflow fork-release.yml --branch vNEW-fork.N --json databaseId,headSha` 找 run，`gh-wait run <id>` 等完（約 50 分鐘：macOS 與 Windows 並行建置，都成功才發布、附 latest.json、更新 cask；任一平台失敗就沒有發版）。失敗看 `--log-failed`；只靠改程式才能修的失敗不在這裡修，通知裡寫原因。
5. 發版成功 → PR 留言結果後關閉，刪 `rebase/vNEW` 與 `ci-base/vNEW`。

## 7. Bark 通知（有做事就推）

保留鎖給人的結局（第 1 步放棄、第 2、3 步修不過、第 4 步不移動），還沒有 PR 就照第 1 步第 6 點開（放棄 rebase 的不要把 HEAD 推上去蓋掉鎖，PR 說明寫卡在哪個檔），再留言 `<!-- auto-rebase:needs-human -->`。沒有這個留言，precheck 六小時後會判定鎖過期，把分支刪掉重跑，使用者接手的東西就沒了。

組內容與送出在同一個 Bash 指令裡：

```
doppler run -p shioaji -c dev -- uv run --no-project python - <<'PY'
import json, os, sys, urllib.request
title = "OpenIDEA fork rebase vNEW：<已發 vNEW-fork.N｜等你看 PR #N｜失敗：哪一步>"
body = """（多行內容）"""
if not title.strip() or not body.strip():
    sys.exit("推播內容是空的，不送")
payload = json.dumps({"title": title, "body": body, "group": "openidea"}, ensure_ascii=False).encode("utf-8")
req = urllib.request.Request(os.environ["BARK_URL"], data=payload, headers={"Content-Type": "application/json; charset=utf-8"})
resp = json.load(urllib.request.urlopen(req, timeout=15))
print("bark:", resp)
sys.exit(0 if resp.get("code") == 200 else 1)
PY
```

body 約 1,000 字內：vOLD → vNEW、模式、衝突各一句、本機閘門與 CI 結果（重跑過的 job、上游也紅的 job）、PR 連結、develop 有沒有移動（沒有就寫原因）、發版結果（tag、release 連結）、對 develop 開著的 PR、第 0 步沒刪的 worktree。發版成功時最後一行固定寫：

```
Mac 與 Windows 的 app 下次啟動會提示更新（內建 updater），按下更新即可
```

最後在對話裡印出和 Bark 一樣的內容。

## 限制

- 不 push `origin`、不對上游開 PR。`main` 與 tag 只在第 6 步動；`develop` 只在第 4 步那一次 lease 推送動。
- 不刪 `backup/*`；不動 `~/Project/openidea` 主 checkout；暫時 worktree 只用 `../ar-$RUN-*`，用完刪。
- 不在本機編 Rust（Mac mini 磁碟），不安裝或更新 app、不開 app。
