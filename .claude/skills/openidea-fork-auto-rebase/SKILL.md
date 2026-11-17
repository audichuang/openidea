---
name: openidea-fork-auto-rebase
description: Unattended pipeline that rebases the OpenIDEA fork's develop onto the newest upstream release, runs the local gates and Fork CI, then moves develop and releases when the rebase was CLEAN or MECHANICAL, or MANUAL that passed its own audit and independent review outside the paths FORK.md reserves for the user; otherwise leaves a PR for the user. Use when the "OpenIDEA fork 自動 rebase" Orca automation fires, or when the user asks to run or resume that pipeline.
---

# OpenIDEA fork 自動 rebase

無人值守：沒有人會回答問題，不要停下來問。repo 是 audichuang/openidea（remote `fork`），上游 l0ng-ai/openidea（remote `origin`）。規則來源是 `git show fork/develop:FORK.md`，先讀全文；這裡沒寫的照它，名詞（CLEAN、MECHANICAL、MANUAL、rebase 鎖）照它的定義。

## 範圍

只做一件事：把 develop 搬到上游最新 release，閘門全過而且是 CLEAN 或 MECHANICAL 就移動 develop 並發版。MANUAL 的照樣盡力解完、跑完閘門，再做第 3b 步的自審：通過就同樣移動 develop 並發版，沒通過才留 PR 給使用者。使用者要的是「不是有衝突就問我」：判斷得了的自己判斷、自己找人審，只把 FORK.md 保留給使用者的東西交回。慢沒關係；做不下去就停下來交人，不要為了發版硬修。

不處理，只列進第 7 步通知：這次沒碰到的既有問題、功能改進與重構、實機 UI 測試。

變數：`SKILL_DIR`＝本檔所在目錄；`MAIN`＝Orca 為這次 run 開的 worktree（開頭 `pwd -P` 記下）；`RUN`＝`date -u +%Y%m%dT%H%M%SZ`，開頭記一次，暫時 worktree 一律叫 `../ar-$RUN-<名字>`；`vNEW`、`vOLD`、`OLD_DEVELOP`、`PR` 在第 0 步定義，`UPSTREAM_BASE` 在第 1 步。每次 Bash 呼叫都是新的 shell，變數不會留到下一次呼叫：寫進指令時一律代換成完整 sha 等實際值；shell 變數後面緊接 `:` 一律寫 `${OLD_DEVELOP}:`（zsh 修飾符）。

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
- 沒有 `rebase/*` 且 vNEW == vOLD：
  - `git ls-remote --tags fork "refs/tags/vNEW-fork.*"` 有東西 → 結束，不推通知。
  - 沒有 → **RELEASE**：develop 已在 vNEW 卻從沒發過 vNEW 的版（有人手動 rebase 後沒發，或前一次 run 移動 develop 後、打 tag 前死了）。發的 sha＝`git rev-parse fork/develop`；先確認它的 develop push Fork CI（`gh run list -R audichuang/openidea --workflow fork-ci.yml --branch develop --commit <sha>`）`Fork CI passed` 成功（precheck 只在綠的時候放行；跑這步時又變了就跳第 7 步通知原因）。沒有 PR、不做第 1～5 步，直接第 6 步；vOLD 取上一個 fork release tag 的上游基底（`git describe --tags --abbrev=0 --match 'v*-fork.*' fork/main`，去掉 `-fork.N`），workflow 清單用上一個 fork release tag 當 OLD_DEVELOP，release notes 的模式寫「develop 已由手動 rebase 搬到 vNEW」，第 6 步第 5 點沒有 PR 可留言。
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
2. `git config rerere.enabled true`，`git checkout --detach OLD_DEVELOP`。上游基底取 `UPSTREAM_BASE=$(git merge-base OLD_DEVELOP origin/main)`（develop 可能停在 release 之後的上游 commit，用 vOLD 當基底會把那幾個上游 commit 當成 fork commit 重放）。解衝突腳本是 fork 自己的檔，rebase 前段還沒重放到它，先取出：`mkdir -p "$MAIN/.rebase-review"; RESOLVE=$MAIN/.rebase-review/resolve-conflicts.py; git show fork/develop:scripts/fork/resolve-conflicts.py > "$RESOLVE"`（不放 `/tmp`：session 重啟時曾被清掉）。再 `pnpm install --frozen-lockfile`：pre-commit hook 要 lint-staged，不能 `--no-verify`。
3. `GIT_EDITOR=true git rebase --onto vNEW "$UPSTREAM_BASE"`，單獨跑、看結束碼（不要接 `| tail`）。每次停在衝突，對每個衝突檔照 FORK.md「Rebase conflicts」分類：
   - locale JSON → `python3 "$RESOLVE" locale <檔>`
   - 兩邊都在檔尾加東西的測試檔 → `python3 "$RESOLVE" append <檔>`
   - `Cargo.lock`、`pnpm-lock.yaml`、`src/bindings.ts` → `git checkout --ours -- <檔>`（rebase 時 ours 是上游），第 4 點重新產生
   - 腳本拒絕（exit 1）或其他任何檔 → MANUAL：保留 fork 功能、採上游新結構自己解；沒把握就 `git rebase --abort`，鎖留著，跳到第 7 步（開 PR、標 needs-human）。
   - 上游改寫 macOS 專案視窗群組（Tab 或全螢幕）而衝突 → 不是交人的產品決策，照 FORK.md 的 standing decision：abort 後在 vNEW 上先 commit 一個退回上游視窗 commit 的 `revert(macos)`，再把 fork 重放到它上面（模式 MANUAL，照常跑完閘門；這些檔在 FORK.md「Reserved for the user」，第 3b 步會交人做實機全螢幕檢查，交的是外觀驗收，不是要使用者做決定）。
   - abort 前在 PR 解法表標出哪些解法改到衝突 hunk 以外的地方（把 fork 的程式搬進上游新檔、補上游新呼叫點）：rerere 只重放 hunk，重跑時這些要手動補回並逐項確認（v0.1.39 漏掉 PR 的兩個 ClipCode 動作實作就是這樣）。

   rerere 或 commit 報 `MERGE_RR.lock`（或其他 `.lock`）已存在：多半是別的 session 在共用的 `.git` 上同時做 merge 或 rebase。不要刪鎖檔：等 30 秒重試同一個動作，最多三次；還不行就照「沒把握」交人。因此沒做成的 commit 用原 commit 的 message 與作者補（`git commit -C <原 commit>`），在 PR 說明記一筆（v0.1.47 的 76a9061bd）。

   腳本已經 `git checkout --conflict=diff3`（rerere 重放過的也會被重建後重解）；解完 `git add <檔>`、`GIT_EDITOR=true git rebase --continue`。停下來卻沒有衝突檔、index 有東西（rerere 重放了先前的解法，`--continue` 報 staged changes）：檢查 diff 後 `git commit -F "$(git rev-parse --git-path rebase-merge/message)"` 再 continue，記成 rerere 重放。把每個衝突檔、它的類別與 commit 記進 `$MAIN/.rebase-review/conflicts.txt`，PR 說明要用。

4. rebase 完重新產生生成檔（在 Mac mini 上 Rust 一律走 `rust-remote`）：`pnpm install --lockfile-only`；`rust-remote --pull Cargo.lock metadata --format-version 1 > /dev/null`。`src/bindings.ts` 也在這裡重新產生：`rust-remote --pull src/bindings.ts test -p openidea --test export_bindings`（衝突時取上游那邊會丟掉該 commit 帶的 fork 指令，v0.1.40 就是這樣）。有差異就一個 commit `chore(fork): 重新產生 lockfile 與 bindings`（MECHANICAL）。編不過就是 rebase 結果有問題，照第 2 步的規則修。
5. 模式：沒有衝突、第 4 點沒產生 commit → CLEAN；只有前三類衝突與第 4 點的 commit → MECHANICAL；其餘（自己解的衝突、任何修正 commit）→ MANUAL。
6. `git push --force fork HEAD:refs/heads/rebase/vNEW`，`git push fork "vNEW^{commit}:refs/heads/ci-base/vNEW"`，開 PR：`gh pr create -R audichuang/openidea --base ci-base/vNEW --head rebase/vNEW --title "[不合併] develop rebase 到 vNEW 的驗證"`，記下 `PR`。body 第一行 `<!-- auto-rebase:old-develop OLD_DEVELOP 的完整 sha -->`，第二行 `<!-- auto-rebase:upstream-base UPSTREAM_BASE 的完整 sha -->`（第 3b 步與續跑要用），其餘寫：為什麼不合併（develop 由 lease 推送移動）、`develop = vOLD(+上游 commit) + N 個 fork commit → vNEW + …`、模式、每個衝突檔的類別與解法、額外 commit。不加任何 attribution 行。

你寫的 commit：message 繁體中文，不加 Co-Authored-By 或任何 attribution 行。

## 2. 本機閘門

先在 PR 留言「本機閘門開始」（心跳）。`pnpm install --frozen-lockfile && mkdir -p dist`，然後各自跑、全部跑完再看結果：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm knip`、`pnpm test`；`rust-remote fmt --all --check`、`rust-remote clippy --workspace --all-targets -- -D warnings`、`rust-remote nextest run --workspace --profile ubuntu-remote --no-fail-fast`（profile 排除 ubuntu 上缺 Go／JDK 的 ide-sdk 測試；`rust-remote` 會照 `git ls-files` 補送 `.gitignore` 過濾漏掉的檔，例如外掛 wasm 和 `crates/ide-ssh/src/target/remote_url.rs`。若仍出現 `dist/plugin.wasm is missing` 或 `E0583` 找不到模組，照 FORK.md Merge gate 手動補送）。

失敗要拿上游對照：`git worktree add --detach ../ar-$RUN-base vNEW`，在那裡跑同一條指令（Rust 一樣走 `rust-remote`，它在遠端用目錄名分開）。兩邊都紅的是上游或環境的，兩份輸出尾段都貼進 PR 說明；只有 fork 紅的是 fork 造成的，要修（修正 commit 讓模式變 MANUAL）。同一個問題修兩輪還不過 → 第 7 步交人。

## 3. Fork CI

`git push --force fork HEAD:refs/heads/rebase/vNEW` 觸發 Fork CI（`fork-ci.yml` 對 `rebase/**` 的 push 也會跑）。用 `gh run list -R audichuang/openidea --workflow fork-ci.yml --branch rebase/vNEW --json databaseId,headSha` 找 `headSha` 等於 HEAD 的 run，`gh-wait run <id> -R audichuang/openidea` 等它（不用 `gh run watch`、不輪詢）。

結果看 `Fork CI passed` 這個 job。Linux Rust job 停在 `Bindings are up to date`，代表第 1 步第 4 點產生的 bindings 和 CI 不一致：重新產生、推上 `rebase/vNEW`（修正 commit，模式變 MANUAL）。`Upstream ci.yml unchanged` 紅了代表上游改了 `ci.yml`：照 FORK.md 把改動移植進 `fork-ci.yml` 並更新 pin（修正 commit，模式變 MANUAL）。其他紅的 job 先 `gh run rerun <id> --failed` 一次；再紅就看上游同一個 job 在 vNEW 是否也紅：`gh run list -R l0ng-ai/openidea --workflow ci.yml --commit $(git rev-parse 'vNEW^{commit}')`。上游也紅 → 不擋（PR 說明附兩邊的 run 連結）；上游綠或沒有可比的 run → fork 造成的，照第 2 步的規則修，修完回到第 3 步。

## 3b. 自審（只有 MANUAL）

前提：第 2 步沒有 fork 造成的紅、第 3 步 `Fork CI passed` 綠。上游也紅的 job 不算綠：先照第 4 步那段修（修正 commit 推上去後回第 2、3 步），修不掉才交人。下面每一處「交人」都是照第 4 步「不符合條件」那段留 needs-human（含交回方法），寫明 3b 做到哪、卡在哪，再跳第 7 步。

先在 PR 留言「自審開始」（心跳：3b 加一輪修正可能跑很久，precheck 六小時沒動靜會判鎖過期）。refs 一律用完整 sha：`OB=UPSTREAM_BASE`、`OT=OLD_DEVELOP`、`NB=$(git rev-parse 'vNEW^{commit}')`、`NT=$(git rev-parse HEAD)`。

1. **必交人路徑**：下面三份檔案清單的聯集，任何一個落在 FORK.md「Reserved for the user」的路徑就交人，留言寫明是哪個路徑、為什麼要人看。
   - 手動碰過的檔：`conflicts.txt` 裡 MANUAL 類的檔，加上 `git range-diff --no-color -s OB..OT NB..NT` 裡 `>`（新增的修正 commit）、`<`（被丟掉的 commit）、+/- 行有變的 `!` commit 改到的檔（`git show --format= --name-only <sha>`）。
   - 上游這次改到的保留路徑：`git diff --name-only OB NB` 落在保留路徑的檔。上游自己改了視窗 chrome，沒有衝突也要實機看。
   - 會削弱閘門的修正：修正 commit 改了 `.config/nextest.toml`、`fork-ci.yml` 裡的測試 filter 或 skip，或刪掉、`#[ignore]`、`.skip` 了測試。同樣交人。純資源設定（磁碟、逾時、runner）不在此列，由審查者看。
2. **對帳腳本**：同一個 Bash 呼叫裡取出並執行，取不到或是空檔就交人：
   ```sh
   AUDIT=$MAIN/.rebase-review/rebase-audit.py
   git show fork/develop:scripts/fork/rebase-audit.py > "$AUDIT" && [ -s "$AUDIT" ] || { echo "rebase-audit.py 取不到"; exit 3; }
   python3 "$AUDIT" --old-base OB --old-tip OT --new-base NB --new-tip NT > "$MAIN/.rebase-review/audit.md"; echo "audit rc=$?"
   ```
   結束碼 0 或 1 才有報告，其他（2、traceback、取不到）都交人。報告的每一項（被丟掉的 commit、+/- 行有變的 commit、新增量找不到的 fork 新增行）都要能用 PR 解法表或額外 commit 解釋，逐項寫進 PR 留言「對帳」。解釋不了的就是 finding。
3. **獨立審查**：用 Agent 工具派一個全新 context 的審查者（general-purpose），給它：
   - `MAIN` 的路徑、四個完整 sha、`FORK.md`、`audit.md`。
   - **不給 PR 的解法表或你的結論**，拿到聲稱的解法就會順著確認。

   請它找下面三類問題，每項附 `檔案:行` 與證據，沒有就明說沒有：
   - fork 功能在新結構裡掉了或接錯：搬到新檔的 hunk、動態 import、事件與設定的接線。
   - 上游新行為被 fork 蓋掉。
   - 只在執行期才會壞的地方。

   範圍限這次 rebase 的變化（`git range-diff` 與衝突檔），不審 OT 裡原本就有的 fork 程式。沒跑起來或沒有結果就交人。

4. **Codex 兜底**：先留心跳留言。用 codex skill 跑 adversarial review，`--base` 是 NB。focus 寫「只看這次 rebase 手解的檔、被丟掉與新增的 commit；OLD_DEVELOP 原本就有的 fork 程式不在範圍」，並列出第 1 點的手動檔清單。Codex 跑不起來或沒有結果就交人，不能跳過。
5. **裁定**：
   - **既有問題**：finding 指到的程式和 OT 的 fork 增量相同（rebase 前就是這樣），只列進第 7 步通知的細節，不擋，也不在這裡修（「範圍」那段）。
   - **其餘 finding**：能用證據證明不成立的，寫進留言駁回；成立的就修（修正 commit），修完回第 2、3 步重跑閘門與 CI，再從本步**第 1 點**重審一次。修正 commit 也可能碰到保留路徑，所以要從第 1 點開始。
   - **通過**：三者都沒有剩下的 finding，對帳項目也都解釋了。
   - **交人**：第二輪還有成立的 finding，或你判斷不了。needs-human 留言列出 finding 與你的看法。
6. 通過 → PR 留言第一行 `<!-- auto-rebase:self-reviewed <NT> -->`，下面寫三者的結果摘要與「未實機測試」，接第 4 步。這個標記只是稽核紀錄，precheck 不讀。run 在這之後、推 develop 之前死掉的話，鎖過期後會從頭重來。

## 4. 移動 develop

條件全部成立才移動：模式是 CLEAN 或 MECHANICAL（或 MANUAL 而第 3b 步通過）、第 2 步沒有 fork 造成的紅、第 3 步 `Fork CI passed` 綠。上游也紅的 job 不算綠：上游已修就搬它的修正，否則修測試或照 #252 加 filter 並開 issue，都是修正 commit（模式變 MANUAL）。推上去後回第 2、3 步，再進第 3b 步（加 filter 屬於削弱閘門，3b 會交人）。從第 0 步 approved 進來的，使用者的核可取代模式條件。

`git rev-parse fork/develop` 已經等於 HEAD（使用者自己移過，或前一次 run 推完還沒留言就死了）→ 不推，直接留 develop-moved 留言。否則：

```sh
git push --force-with-lease=develop:OLD_DEVELOP fork HEAD:develop
```

lease 失敗（develop 在這期間合進了別的 PR）→ HEAD 不在 `fork/develop` 或 `fork/backup/*` 上就先 `git push fork "HEAD:refs/heads/backup/rebase-vNEW-$RUN"`（從 approved 進來的 HEAD 含使用者審過的解法），再 PR 留言說明後關閉、刪 `rebase/vNEW` 與 `ci-base/vNEW`，通知「下一次 run 從新的 develop 重來」，結束。成功 → PR 留言 `<!-- auto-rebase:develop-moved <HEAD 完整 sha> -->`。

develop 一移動（含已在 HEAD 不重推的情況）就列出這次 rebase 帶進 develop 的 workflow：`git diff --diff-filter=A --name-only OLD_DEVELOP <develop sha> -- .github/workflows/`，`<develop sha>` 在這裡是 HEAD。兩端都用 sha、不用 vOLD／vNEW：tag 可變（上游改過 v0.1.37 的 tag，第 0 步會強制更新 tags），恢復時重新解析會漏列。`gh workflow list -R audichuang/openidea --all --json path,state,name` 裡 path 在這份清單、state 是 active 的，照 FORK.md 馬上 `gh workflow disable`，寫進通知。只比對這份路徑清單：fork 自己的 workflow（包括已刪分支留下的 `zz-*` 註冊）也是 active、名稱也不是 Fork CI，用名稱篩會誤停。`pull_request_target` 從 PR 的 base 分支讀 workflow，develop 一動，下一個對 develop 開的 PR 就會觸發它（v0.1.35 的 `PR check` 幾秒內就在 PR 上貼了 needs-info）。清單裡還沒出現的，第 6 步移動 main 後再查一次。接第 5 步。

不符合條件（MANUAL 而自審沒通過或碰到必交人路徑，或有修不掉的紅）→ 不移動，PR 留言 `<!-- auto-rebase:needs-human -->` 加上要使用者看什麼（自審做到哪、卡在哪），最後一段固定寫交回方法：看完沒問題就另留一則第一行是 `<!-- auto-rebase:approved <HEAD 完整 sha> -->` 的留言，下一次排程（每小時 :37）會移動 develop 並發版。不要給使用者手動 lease 推送或發版的指令。跳第 7 步。

## 5. 對 develop 開著的 PR

`gh pr list -R audichuang/openidea --base develop --state open`：每個 PR 的分支都還在舊基底上，留言請它照 FORK.md 用 `git rebase --onto fork/develop <舊 merge-base>` 搬過來。不要替它搬。

## 6. 發版

1. 先查要發的 sha 是否已有 tag：`git ls-remote --tags fork "refs/tags/vNEW-fork.*"` 裡有指向它的（annotated tag 看 `^{}` 那行），代表前一次 run 推完 tag 後死了：沿用那個 tag，先做第 3 點結尾的 workflow 檢查（前一次 run 可能死在 disable 之前），再跳到第 4 點看它的 fork-release run（失敗就 `gh run rerun <id>`；找不到這個 tag 的 run 就寫進通知交人；fork-release 也會在 develop push 與每週排程跑候選版，那些 run 不算這個 tag 的發版），不要再發新 N。沒有才算 N：最大的 N 加一，沒有就 1。
2. 寫 release notes（繁體中文，使用者看得到的變化；不寫 commit 雜訊）存成 `$MAIN/.rebase-review/notes.md`：
   - 第一行：`基於上游 vNEW（上一版基於 vOLD）`
   - 上游這次的重點：讀 `gh release view <tag> -R l0ng-ai/openidea --json body` 裡 vOLD 之後到 vNEW 的每一版，挑使用者看得到的改動，每項一行
   - fork 這次的改動：拿 `git log --format=%s vNEW..HEAD` 和上一個 fork release tag 的 `git log --format=%s <它的上游基底>..<tag>` 比，標題是新的才列；都沒有就寫「fork 功能無變更，只跟上上游」
   - 這次 rebase 的模式與衝突一句話；第 3b 步放行的寫「MANUAL，自審通過，未實機測試」
3. 移動 main 並推 annotated tag，同一次推送：
   ```sh
   old=$(git ls-remote fork refs/heads/main | cut -f1)
   git tag -a vNEW-fork.N <develop-moved 的 sha> -F "$MAIN/.rebase-review/notes.md"
   git push --atomic --force-with-lease=main:$old fork <sha>:refs/heads/main vNEW-fork.N
   ```
   推完再用第 4 步同一份路徑清單查一次 `gh workflow list`，main 移動後才出現註冊的就 disable。從第 0 步 develop-moved 進來的沒跑過第 4 步，在這裡照第 4 步的指令列清單，`<develop sha>` 是留言裡的 sha，OLD_DEVELOP 取 PR 說明。
4. 用 `gh-wait tag vNEW-fork.N -R audichuang/openidea --workflow fork-release.yml` 等完（它只追這個 tag 開的 run；同一個 sha 在 develop push 時跑的候選版不算）。不帶參數的 `gh-wait` 看的是本機 HEAD，這裡推的是 refspec 與 tag，不能用；`-R` 一定要帶，fork checkout 的預設 repo 是上游。tag 的 commit 與版本和 develop 候選版相符時 tag run 不建置：plan 等候選版跑完（可能三、四十分鐘）再發布它的 assets；候選版失敗或版本不符時才自己並行建置 macOS 與 Windows（FORK.md Release）。兩種都是兩個平台都成功才發布、附 latest.json、更新 cask。失敗看 tag run 的 `--log-failed`，重用失敗時也看候選版 run；只靠改程式才能修的失敗不在這裡修，通知裡寫原因。
5. 發版成功 → PR 留言結果後關閉，刪 `rebase/vNEW` 與 `ci-base/vNEW`。
6. 再跑 `"$SKILL_DIR/scripts/mark-releases-done.sh" vNEW`：把使用者 GitHub 收件匣裡 vNEW（含）以前的 l0ng-ai/openidea release 通知標成 Done，使用者看收件匣沒有上游 release 就知道 fork 已跟上。失敗（結束碼非 0）不擋收尾，寫進第 7 步通知。

## 7. Bark 通知（有做事就推）

保留鎖給人的結局（第 1 步放棄、第 2、3 步修不過、第 4 步不移動），還沒有 PR 就照第 1 步第 6 點開（放棄 rebase 的不要把 HEAD 推上去蓋掉鎖，PR 說明寫卡在哪個檔），再留言 `<!-- auto-rebase:needs-human -->`。沒有這個留言，precheck 六小時後會判定鎖過期，把分支刪掉重跑，使用者接手的東西就沒了。

組內容與送出在同一個 Bash 指令裡：

```
doppler run -p shioaji -c dev -- uv run --no-project python - <<'PY'
import json, os, sys, urllib.request
title = "OpenIDEA fork <已發 vNEW-fork.N｜vNEW 等你看 PR #N｜vNEW 卡在第 X 步>"
body = """（最多 4 行）"""
if not title.strip() or not body.strip():
    sys.exit("推播內容是空的，不送")
payload = json.dumps({"title": title, "body": body, "group": "openidea"}, ensure_ascii=False).encode("utf-8")
req = urllib.request.Request(os.environ["BARK_URL"], data=payload, headers={"Content-Type": "application/json; charset=utf-8"})
resp = json.load(urllib.request.urlopen(req, timeout=15))
print("bark:", resp)
sys.exit(0 if resp.get("code") == 200 else 1)
PY
```

使用者在手機上看推播，嫌逐項列出太複雜。body 最多 4 行、每行一件事，不寫 sha、run id、衝突細節：

1. 結果一句：跟上哪一版上游、模式（自審放行的寫「MANUAL，自審通過，未實機測試」）；沒發版就寫為什麼（必交人路徑、自審 finding、哪一步紅、lease 失敗）
2. 只有使用者能做的事（有才寫，例如看 PR、處理第 0 步沒刪的 worktree）。對 develop 開著的 PR 已在 PR 上留言，不寫
3. 一個連結：發版成功給 release，否則給 PR
4. 發版成功時固定寫：`app 下次啟動會提示更新，按更新即可`

例：

```
跟上上游 v0.1.41（MANUAL，已核可）
https://github.com/audichuang/openidea/releases/tag/v0.1.41-fork.1
app 下次啟動會提示更新，按更新即可
```

閘門與 CI 的狀態照實寫：有「上游也紅」或排除不擋的項目時，不寫「都綠」「全過」，寫「N 個和上游一樣紅」（v0.1.47 的推播說閘門都綠，其實遠端 nextest 有 2 個和上游一樣的紅）。

細節（衝突、閘門與 CI、重跑過或上游也紅的 job、develop 有沒有移動、對 develop 開著的 PR、沒刪的 worktree）寫在 PR 留言與對話裡。前面各步說「列進通知」「寫進通知」的，也寫在這些細節裡，只有要使用者動手的才進 Bark。最後在對話裡印出 Bark 的內容，再列這些細節。

## 限制

- 不 push `origin`、不對上游開 PR。`main` 與 tag 只在第 6 步動；`develop` 只在第 4 步那一次 lease 推送動。
- 不刪 `backup/*`；不動 `~/Project/openidea` 主 checkout；暫時 worktree 只用 `../ar-$RUN-*`，用完刪。
- 不在本機編 Rust（Mac mini 磁碟），不安裝或更新 app、不開 app。
