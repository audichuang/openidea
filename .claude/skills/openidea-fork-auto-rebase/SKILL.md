---
name: openidea-fork-auto-rebase
description: Unattended pipeline that rebases the OpenIDEA fork's develop onto the newest upstream release, runs the local gates and Fork CI, then moves develop and releases when the rebase was CLEAN or MECHANICAL, or MANUAL that passed its own audit and independent review outside the paths FORK.md reserves for the user (window chrome it checks itself in the real app on the Mac mini); otherwise leaves a PR for the user. Use when the "OpenIDEA fork 自動 rebase" Orca automation fires, or when the user asks to run or resume that pipeline.
---

# OpenIDEA fork 自動 rebase

無人值守：沒有人會回答問題，不要停下來問。repo 是 audichuang/openidea（remote `fork`），上游 l0ng-ai/openidea（remote `origin`）。規則來源是 `git show fork/develop:FORK.md`，先讀全文；這裡沒寫的照它，名詞（CLEAN、MECHANICAL、MANUAL、rebase 鎖）照它的定義。

## 範圍

只做一件事：把 develop 搬到上游最新 release，閘門全過而且是 CLEAN 或 MECHANICAL 就移動 develop 並發版。MANUAL 的照樣盡力解完、跑完閘門，再做第 3b 步的自審：通過就同樣移動 develop 並發版，沒通過才留 PR 給使用者。使用者要的是「不是有衝突就問我」：判斷得了的自己判斷、自己找人審；不擋使用的 finding 開 issue 列為已知問題（第 3b 步第 5 點）；視窗 chrome 由第 3c 步在本機實機檢查，只把 FORK.md 保留給使用者的其他東西和檢查沒過的交回。交回時只留使用者才能決定或才做得到的事。慢沒關係；做不下去就停下來交人，不要為了發版硬修。

不處理，只列進第 7 步通知：這次沒碰到的既有問題、功能改進與重構、第 3c 步以外的實機 UI 測試。

變數：`SKILL_DIR`＝本檔所在目錄；`MAIN`＝Orca 為這次 run 開的 worktree（開頭 `pwd -P` 記下）；`RUN`＝`date -u +%Y%m%dT%H%M%SZ`，開頭記一次，暫時 worktree 一律叫 `../ar-$RUN-<名字>`；`vNEW`、`vOLD`、`OLD_DEVELOP`、`PR` 在第 0 步定義，`UPSTREAM_BASE` 在第 1 步。每次 Bash 呼叫都是新的 shell，變數不會留到下一次呼叫：寫進指令時一律代換成完整 sha 等實際值；shell 變數後面緊接 `:` 一律寫 `${OLD_DEVELOP}:`（zsh 修飾符）。

PR 留言的標記（`<!-- auto-rebase:… -->`）一律放在留言第一行最前面：precheck 只認開頭的標記。

## 0. 決定模式

```sh
git fetch fork --tags && git fetch origin --no-tags '+refs/tags/v*:refs/tags/v*' && git fetch origin main
```

- vNEW＝`gh api repos/l0ng-ai/openidea/releases/latest --jq .tag_name`（須符合 `^v[0-9]+\.[0-9]+\.[0-9]+$`）。
- vOLD＝`git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-fork*' fork/develop`。
- 鎖用 `git ls-remote fork 'refs/heads/rebase/*'` 判斷。有 `rebase/vX`：
  - PR 開著、有 `<!-- auto-rebase:develop-moved <sha> -->` 留言（前一次 run 移動 develop 後、發版途中死了，或發版失敗）→ vNEW=vX、PR=那個 PR，直接做第 6 步，發的是最後一則 develop-moved 留言裡的 sha；vOLD 與 OLD_DEVELOP 取 PR 說明。
    - 例外：那個 sha 已有 `vX-fork.N` tag，但這個 tag 沒有已發布的 Release（`gh release view <tag> -R audichuang/openidea` 失敗），它最近一次 fork-release run 是 completed failure，而 `fork/develop` 已經越過它（`git merge-base --is-ancestor <sha> fork/develop` 成功、兩者不同），`fork/develop` 的 develop push Fork CI `Fork CI passed` 成功。tag 的 run 永遠用 tag 那個 commit 的 workflow，所以 workflow 本身的問題重跑修不好，只能發新的 commit（v0.1.48-fork.1：macOS 的 tsc 超過 Node heap，#354、#355）。
    - 這時改發 `fork/develop`：先在 PR 留一則第一行是 `<!-- auto-rebase:develop-moved <fork/develop 完整 sha> -->` 的留言，寫明舊 tag 為什麼失敗、`<舊 sha>..fork/develop` 帶進哪些 commit，再做第 6 步。第 6 步第 1 點會照常算下一個 N；舊 tag 不刪也不移。precheck 看到這個狀態就起 run，不等鎖過期。
  - PR 開著、沒有 develop-moved、**最後一則** `<!-- auto-rebase:approved <sha> -->` 留言排在最後一則 needs-human 之後、sha 等於 `git rev-parse fork/rebase/vX`（使用者看過 needs-human 的 PR 後核可；和 precheck 同一個定義。sha 不等代表核可後又推過；排在 needs-human 之前代表之前的 run 已拒絕它。兩者都是核可作廢，照下一條處理）→ vNEW=vX、PR=那個 PR，vOLD 與 OLD_DEVELOP 取 PR 說明。先確認 Fork CI 在這個 sha 上 `Fork CI passed` 成功，或紅的 job 都已在 PR 說明列為上游在 vX 也紅（第 3 步的規則）；不符就 PR 留言 `<!-- auto-rebase:needs-human -->` 說明哪裡不符，跳第 7 步。都符合就 `git checkout --detach <sha>`，從第 4 步「移動」做起（不重跑 rebase 與閘門），接著第 5、6 步。
  - PR 開著、有 `<!-- auto-rebase:needs-human -->` 留言、沒有符合上一條的 approved（precheck 只在它過時才讓你跑到這：上游出了更新的 release，或 develop 已經在 vX）→ **收鎖**：`rebase/vX` 的 tip 不在 `fork/develop` 或 `fork/backup/*` 上就先 `git push fork "fork/rebase/vX:refs/heads/backup/rebase-vX-$RUN"`；PR 留言說明原因後 `gh pr close`，刪 fork 的 `rebase/vX` 與 `ci-base/vX`。然後重新判斷：vNEW == vOLD 就結束、不推通知；否則 NEW。
  - 其他（precheck 判定鎖過期：前一次 run 死了）→ 同樣先備份不在 develop／backup 上的 tip、關 PR（有的話）、刪兩條分支，當 NEW 從頭來。不續跑半途的 rebase：從頭重來比較可靠。
- 沒有 `rebase/*` 且 vNEW == vOLD：
  - `git ls-remote --tags fork "refs/tags/vNEW-fork.*"` 有東西 → 結束，不推通知。例外是上一條說的發版失敗：最新的 `vNEW-fork.N` tag 沒有已發布的 Release、它的 fork-release run 是 completed failure、`fork/develop` 已越過它而 develop push Fork CI `Fork CI passed` 成功（precheck 印 `release failed: …`）→ 照下面的 **RELEASE** 發 `fork/develop`，N 加一，舊 tag 不刪也不移。發版失敗的 run 自己收了鎖時就是這個狀態。
  - 沒有 → **RELEASE**：develop 已在 vNEW 卻從沒發過 vNEW 的版（有人手動 rebase 後沒發，或前一次 run 移動 develop 後、打 tag 前死了）。發的 sha＝`git rev-parse fork/develop`；先確認它的 develop push Fork CI（`gh run list -R audichuang/openidea --workflow fork-ci.yml --branch develop --commit <sha>`）`Fork CI passed` 成功（precheck 只在綠的時候放行；跑這步時又變了就跳第 7 步通知原因）。沒有 PR、不做第 1～5 步，直接第 6 步；vOLD 取上一個已發布的 fork release 的上游基底（`gh release list -R audichuang/openidea --exclude-drafts --exclude-pre-releases --limit 1 --json tagName --jq '.[0].tagName'`，去掉 `-fork.N`；只有 tag、沒發布的不算，`git describe` 會抓到它），workflow 清單用那個 release 的 tag 當 OLD_DEVELOP，release notes 的模式寫「develop 已由手動 rebase 搬到 vNEW」，第 6 步第 5 點沒有 PR 可留言。
- 否則 **NEW**：`OLD_DEVELOP=$(git rev-parse fork/develop)`。

開始前清掉之前 run 留下的 worktree：`git worktree list` 裡路徑含 `auto-openidea-fork-rebase` 而且不是 `MAIN` 的、目錄名以 `ar-` 開頭但 `$RUN` 不是這次的，只在 `git -C <路徑> status --porcelain -- . ':!.rebase-review'` 沒輸出（`.rebase-review/` 是每次 run 自己寫的，notes 已進 tag 說明，不算）、不在 rebase 中、`git -C <路徑> branch -r --contains HEAD` 列得出 `fork/` 分支時刪（Orca 開的用 `orca worktree rm --worktree "id:38d295e1-a1dd-4eea-871a-5bbe1bef2554::<路徑>" --force --json`，其他用 `git worktree remove --force`），刪完再 `git branch -D` 它原本所在的 `audichuang/auto-openidea-fork-rebase-run-*` 本地分支（有的話）；其餘列進通知。之前的 run 死在第 3c 步時，它的 dev app 可能還開著：`pgrep -fl target/debug/openidea` 裡路徑在上面那些舊 run worktree 底下的，先停它的程序樹（第 3c 步第 7 點的 `tree`，從那個 app 的 pid 往上找到 `pnpm dev:app` 再停），再刪它的 `~/Library/Application Support/<identifier>/` 與 `~/Library/Caches/<identifier>/`（在那個 worktree 裡跑 `node -e 'import("./scripts/dev-session.ts").then(m=>console.log(m.worktreeId(process.cwd())))'` 取得 identifier）；不算第 3c 步說的「別人的 dev app」。

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
   - 衝突 hunk 只有單行 `import`／`use` → `python3 "$RESOLVE" imports <檔>`（多行 import 清單或夾著程式碼的，腳本會拒絕；它不照 rustfmt 排序，交給 fmt 閘門）
   - `Cargo.lock`、`pnpm-lock.yaml`、`src/bindings.ts` → `git checkout --ours -- <檔>`（rebase 時 ours 是上游），第 4 點重新產生
   - 腳本拒絕（exit 1）或其他任何檔 → MANUAL：保留 fork 功能、採上游新結構自己解；沒把握就 `git rebase --abort`，鎖留著，跳到第 7 步（開 PR、標 needs-human）。
   - 上游改寫 macOS 專案視窗群組（Tab 或全螢幕）而衝突 → 不是交人的產品決策，照 FORK.md 的 standing decision：abort 後在 vNEW 上先 commit 一個退回上游視窗 commit 的 `revert(macos)`，再把 fork 重放到它上面（模式 MANUAL，照常跑完閘門；這些檔在 FORK.md「Reserved for the user」第一項，由第 3c 步實機檢查全螢幕與 tab，沒過才交人）。
   - abort 前在 PR 解法表標出哪些解法改到衝突 hunk 以外的地方（把 fork 的程式搬進上游新檔、補上游新呼叫點）：rerere 只重放 hunk，重跑時這些要手動補回並逐項確認（v0.1.39 漏掉 PR 的兩個 ClipCode 動作實作就是這樣）。

   rerere 或 commit 報 `MERGE_RR.lock`（或其他 `.lock`）已存在：多半是別的 session 在共用的 `.git` 上同時做 merge 或 rebase。不要刪鎖檔：等 30 秒重試同一個動作，最多三次；還不行就照「沒把握」交人。因此沒做成的 commit 用原 commit 的 message 與作者補（`git commit -C <原 commit>`），在 PR 說明記一筆（v0.1.47 的 76a9061bd）。

   腳本已經 `git checkout --conflict=diff3`（rerere 重放過的也會被重建後重解）；解完 `git add <檔>`、`GIT_EDITOR=true git rebase --continue`。停下來卻沒有衝突檔、index 有東西（rerere 重放了先前的解法，`--continue` 報 staged changes）：檢查 diff 後 `git commit -F "$(git rev-parse --git-path rebase-merge/message)"` 再 continue，記成 rerere 重放。把每個衝突檔、它的類別與 commit 記進 `$MAIN/.rebase-review/conflicts.txt`，PR 說明要用。

4. rebase 完重新產生生成檔（在 Mac mini 上 Rust 一律走 `rust-remote`）：`pnpm install --lockfile-only`；`rust-remote --pull Cargo.lock metadata --format-version 1 > /dev/null`。`src/bindings.ts` 也在這裡重新產生：`rust-remote --pull src/bindings.ts test -p openidea --test export_bindings`（衝突時取上游那邊會丟掉該 commit 帶的 fork 指令，v0.1.40 就是這樣）。有差異就一個 commit `chore(fork): 重新產生 lockfile 與 bindings`（MECHANICAL）。編不過就是 rebase 結果有問題，照第 2 步的規則修。
5. 模式：沒有衝突、第 4 點沒產生 commit → CLEAN；衝突全是第 3 點的機械類（locale、append、imports、生成檔，由腳本解或取上游後重新產生）加上第 4 點的 commit → MECHANICAL；其餘（自己解的衝突、任何修正 commit）→ MANUAL。
6. `git push --force fork HEAD:refs/heads/rebase/vNEW`，`git push fork "vNEW^{commit}:refs/heads/ci-base/vNEW"`，開 PR：`gh pr create -R audichuang/openidea --base ci-base/vNEW --head rebase/vNEW --title "[不合併] develop rebase 到 vNEW 的驗證"`，記下 `PR`。body 第一行 `<!-- auto-rebase:old-develop OLD_DEVELOP 的完整 sha -->`，第二行 `<!-- auto-rebase:upstream-base UPSTREAM_BASE 的完整 sha -->`（第 3b 步與續跑要用），其餘寫：為什麼不合併（develop 由 lease 推送移動）、`develop = vOLD(+上游 commit) + N 個 fork commit → vNEW + …`、模式、每個衝突檔的類別與解法、額外 commit。不加任何 attribution 行。

你寫的 commit：message 繁體中文，不加 Co-Authored-By 或任何 attribution 行。

## 2. 本機閘門

先在 PR 留言「本機閘門開始」（心跳）。`pnpm install --frozen-lockfile && mkdir -p dist`，然後各自跑、全部跑完再看結果：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm knip`、`pnpm test`；`rust-remote fmt --all --check`、`rust-remote clippy --workspace --all-targets -- -D warnings`、`rust-remote nextest run --workspace --profile ubuntu-remote --no-fail-fast`（profile 排除 ubuntu 上缺 Go／JDK 的 ide-sdk 測試；`rust-remote` 會照 `git ls-files` 補送 `.gitignore` 過濾漏掉的檔，例如外掛 wasm 和 `crates/ide-ssh/src/target/remote_url.rs`。若仍出現 `dist/plugin.wasm is missing` 或 `E0583` 找不到模組，照 FORK.md Merge gate 手動補送）。

失敗要拿上游對照：`git worktree add --detach ../ar-$RUN-base vNEW`，在那裡跑同一條指令（Rust 一樣走 `rust-remote`，它在遠端用目錄名分開）。兩邊都紅的是上游或環境的，兩份輸出尾段都貼進 PR 說明；只有 fork 紅的是 fork 造成的，要修（修正 commit 讓模式變 MANUAL）。同一個問題修兩輪還不過 → 第 7 步交人。

## 3. Fork CI

`git push --force fork HEAD:refs/heads/rebase/vNEW` 觸發 Fork CI（`fork-ci.yml` 對 `rebase/**` 的 push 也會跑）。用 `gh run list -R audichuang/openidea --workflow fork-ci.yml --branch rebase/vNEW --json databaseId,headSha` 找 `headSha` 等於 HEAD 的 run，`gh-wait run <id> -R audichuang/openidea` 等它（不用 `gh run watch`、不輪詢）。

`fork-ci.yml` 裡註解標 #252 的 filter（上游也紅而加的），對照上游 NB 的同一個 job：上游已經綠的，在 #252 留言列出可以拿掉的條目和上游 run，寫進第 7 步細節。這一輪不拿掉：拿掉後 fork 紅了，要放回去又是削弱閘門。之後由一般 PR 拿掉。

結果看 `Fork CI passed` 這個 job。Linux Rust job 停在 `Bindings are up to date`，代表第 1 步第 4 點產生的 bindings 和 CI 不一致：重新產生、推上 `rebase/vNEW`（修正 commit，模式變 MANUAL）。`Upstream ci.yml unchanged` 紅了代表上游改了 `ci.yml`：照 FORK.md 把改動移植進 `fork-ci.yml` 並更新 pin（修正 commit，模式變 MANUAL）。其他紅的 job 先 `gh run rerun <id> --failed` 一次；再紅就看上游同一個 job 在 vNEW 是否也紅：`gh run list -R l0ng-ai/openidea --workflow ci.yml --commit $(git rev-parse 'vNEW^{commit}')`。上游也紅 → 不擋（PR 說明附兩邊的 run 連結）；上游綠或沒有可比的 run → fork 造成的，照第 2 步的規則修，修完回到第 3 步。

## 3b. 自審（只有 MANUAL）

前提：第 2 步沒有 fork 造成的紅、第 3 步 `Fork CI passed` 綠。上游也紅的 job 不算綠：先照第 4 步那段修（修正 commit 推上去後回第 2、3 步），修不掉才交人。下面每一處「交人」都是照第 4 步「不符合條件」那段留 needs-human（含交回方法），寫明 3b 做到哪、卡在哪，再跳第 7 步。

先在 PR 留言「自審開始」（心跳：3b 加一輪修正可能跑很久，precheck 六小時沒動靜會判鎖過期）。下面的 OB、OT、NB、NT 是佔位字，寫進指令時代換成完整 sha：OB＝UPSTREAM_BASE、OT＝OLD_DEVELOP、NB＝`git rev-parse 'vNEW^{commit}'`、NT＝`git rev-parse HEAD`。每一輪（含修正後重審）開頭都重新取 NT，清單與報告都用這一輪的 NT 重建。

1. **必交人路徑**：下面三份檔案清單的聯集，任何一個落在 FORK.md「Reserved for the user」的路徑就交人，留言寫明是哪個路徑、為什麼要人看。例外：命中的全是保留清單第一項（視窗 chrome）時不交人，記下命中的檔，其餘各點照做，通過後接第 3c 步實機檢查。
   - 手動碰過的檔：`conflicts.txt` 裡 MANUAL 類的檔，加上 `git range-diff --no-color OB..OT NB..NT` 裡 `>`（新增的修正 commit）與 `<`（被丟掉的 commit）改到的所有檔（`git show --format= --name-status <sha>`，rename 的來源與目的路徑都算），以及 `!` commit 裡 +/- 行有變的檔。`!` 的算到檔案，不算整個 commit：取第 2 點對帳報告「`!` with different +/- lines」在每個 commit 底下列的檔（所以先跑第 2 點）。同一個 commit 裡 rebase 前後 +/- 行相同的檔不算：v0.1.48 有 ClipCode 的 commit 只是 `Cargo.lock` 與註冊行變了，`crates/ide-clip/**` 逐位元組沒變，照 commit 算會誤判成碰到 ClipCode。
   - 上游這次改到的視窗 chrome：`git diff --name-status OB NB` 落在保留清單第一項（macOS 視窗 chrome）的檔，rename 的來源與目的路徑都算（上游把保留檔搬走也要人看，FORK.md 的清單跟著更新）。上游自己改了它，沒有衝突也要實機看（第 3c 步）；上游改其他保留路徑不算。
   - 會削弱閘門的修正：修正 commit 改了 `.config/nextest.toml`、`fork-ci.yml` 裡的測試 filter 或 skip，或刪掉、`#[ignore]`、`.skip` 了測試。同樣交人。純資源設定（磁碟、逾時、runner）不在此列，由審查者看。
     - 例外：**上游也紅的測試**。上游沒有修正可搬時，照 #252 加 filter 不交人，但下面每一條都要成立。證據只能來自上游自己在 NB 的 CI，不能來自這次的修正：
       - 上游 `ci.yml` 在 NB 的 run（第 3 步那條 `gh run list -R l0ng-ai/openidea --workflow ci.yml --commit <NB>`）裡，同一個 job 也是紅的。
       - fork 的 job 重跑一次（第 3 步）後仍紅。
       - fork 失敗的測試全都在上游那個 job 的失敗清單裡，而且失敗位置或訊息主體相同，只有名字相同不算。fork 多紅一個，就照「其餘 finding」修或交人：fork 自己弄壞的不能躲在上游的紅後面。
       - 是測試失敗。編不過、job 沒跑起來、逾時被取消都不算。
       - filter 只寫完整測試名（nextest `test(=…)`、Playwright 的 spec 與標題），只套在紅的那個平台的 job。註解寫上游 run 的連結，並開 issue 或在 #252 留言（測試名、兩邊 run、失敗訊息）。

       第 3 點的獨立審查者另外核對這項：只給它 fork 與上游的兩個 run id，以及 filter 的 diff，不給你整理的清單；請它確認上面每一條。不成立就交人。PR 留言、release notes 與 Bark 寫「N 個上游也紅的測試已加 filter（#…）」。
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

   範圍限這次 rebase 的變化（`git range-diff`、衝突檔，以及 OB..NB 上游的改動是否讓沒改的 fork 呼叫、事件、設定失效），不審 OT 裡本來就壞的東西。沒跑起來或沒有結果就交人。

4. **Codex 兜底**：先留心跳留言。用 codex skill 跑 adversarial review，`--base` 是 NB。focus 寫「只看這次 rebase 手解的檔、被丟掉與新增的 commit；OLD_DEVELOP 原本就有的 fork 程式不在範圍」，並列出第 1 點的手動檔清單。Codex 跑不起來或沒有結果就交人，不能跳過。
5. **裁定**：
   - **既有問題**：只有能證明同一個失敗在 OT 上就存在（rebase 前就壞），才只列進第 7 步通知的細節，不擋，也不在這裡修（「範圍」那段）。fork 程式沒改不等於沒事：上游換了它依賴的結構、事件或設定（v0.1.47 拆 GitLog 後，`gitGraphBridge.ts` 原封不動的動態 import 就失效了），這類算這次的 finding。
   - **已知問題**：成立、但不值得為它擋住發版的 finding。下面每一條都要成立，並各附一句證據寫進留言；任何一條說不出證據就不適用：
     - 不是回歸：OT 上使用者能用的行為沒有變差。典型是上游這一版的新功能在 fork 上不完整。rebase 前能用、現在壞掉或變差的一律不適用。
     - 不遺失或損壞資料、不當機、不卡住 UI。
     - 不放寬 trust、權限或其他安全檢查。
     - 不在 FORK.md「Reserved for the user」的路徑上。
     - 根治要動結構（新 IPC 指令、跨 crate 介面、bindings），不是幾行修正。幾行修得掉的照「其餘 finding」修。
     - 審查者與 Codex 都沒有把它評為 high 或 blocking。

     動作：`gh issue create -R audichuang/openidea` 開 fork issue（現象、原因、影響、修法、來源 PR），issue 編號寫進 self-reviewed 留言、release notes 的「已知問題」和第 7 步的細節。不算剩下的 finding，不擋，也不用為它再審一輪（v0.1.48 的 #350：外掛讀剪貼簿在檔案加文字的混合格式下只拿到檔名；沒有這個出口時整輪交人）。

   - **上游功能的 finding**：根源在上游這一版的程式（OB..NB 新增或改寫的功能），不是 rebase 解衝突或 fork 修正造成的。這不是產品取捨，不交人，依情況擇一：
     - **上游換掉了 OT 上的行為**（同一個入口在 OT 走 fork 或舊路徑，現在走上游新實作），而新實作有遺失資料、當機、卡住 UI 的 finding，或掉了 fork 功能（ClipCode、語言功能等）：這是回歸。照 v0.1.49 的 #397 做：加一個 fork 開關（預設維持 OT 行為，上游程式與測試保留，測試裡把開關打開照跑），另加一個 fork 測試斷言預設走 OT 路徑。
     - **純新增的上游功能**（OT 沒有對應行為）有遺失資料的 finding：同樣用 fork 開關把它的入口關掉（可還原），不替上游修。不會遺失資料的照「已知問題」的條件判斷。
     - 牽涉到的程式在 OT 就有、只是新功能讓它比較容易碰到（例：v0.1.49 存檔途中打字被清 dirty，#398）：開關處理後回到 OT 的路徑，照「既有問題」處理，開 issue。

     動作：開關是修正 commit（回第 2、3 步，再從第 1 點重審；開關若落在保留路徑就照第 1 點交人）。開 fork issue（現象、為什麼關、上游修好後怎麼打開），編號寫進 self-reviewed 留言、release notes（寫「上游 #… 的〇〇維持 fork 原本的行為」）與第 7 步的細節。這是替使用者做的預設選擇：通知寫一句說明，使用者要上游行為再打開開關。v0.1.49 沒有這個出口，整輪交人只為了問「要不要用上游的輕量視窗」（#394）。

   - **其餘 finding**：能用證據證明不成立的，寫進留言駁回；成立的就修（修正 commit），修完回第 2、3 步重跑閘門與 CI，再從本步**第 1 點**重審一次。修正 commit 也可能碰到保留路徑，所以要從第 1 點開始。
   - **通過**：三者都沒有剩下的 finding（列為已知問題、或以 fork 開關處理的上游功能 finding 不算），對帳項目也都解釋了。
   - **交人**：第二輪還有成立、又不符合已知問題或上游功能條件的 finding，或你判斷不了、問過 advisor 也判斷不了。needs-human 留言列出 finding 與你的看法。交人前，最後一輪審查之後才加的修正 commit 也要審完：第 3 點的獨立審查者與第 4 點的 Codex 各看那幾個 commit 一次（不另算一輪，也不因此再修），結果寫進 needs-human 的細節。使用者核可的是整個 NT，不該由他當最後一個審查者（v0.1.49 的 needs-human 要使用者「看 4 個修正 commit」，其中 `9a38ecea7` 沒經過任何審查）。交人前，第 1 點命中的全是視窗 chrome（沒有命中其他保留項）、閘門與 Fork CI 也是綠的，就先做第 3c 步：使用者核可的是這個 NT，chrome 不該留給他在實機看。3c 的結果（chrome-verified 或失敗的那一項）寫進 needs-human。
6. 通過 → 確認 `git rev-parse HEAD` 等於這一輪審過的 NT（不等就回第 1 點），PR 留言第一行 `<!-- auto-rebase:self-reviewed <NT> -->`，下面寫三者的結果摘要，接第 3c 步（第 1 點有視窗 chrome 命中時）或第 4 步。這個標記只是稽核紀錄，precheck 不讀。run 在這之後、推 develop 之前死掉的話，鎖過期後會從頭重來。

## 3c. 視窗 chrome 實機檢查（任何模式）

時機：第 3b 步第 1 點的保留路徑檢查（CLEAN、MECHANICAL 在第 4 步也做這一點）命中的**全是**保留清單第一項（macOS 視窗 chrome），而且 MANUAL 的 3b 其餘各點都已通過，或 3b 正要為了和視窗 chrome 無關的理由交人（第 3b 步第 5 點「交人」：這時做完照樣交人，不接第 4 步的移動）。命中其他保留項就照舊交人，不做這步；從第 0 步 approved 進來的也不做。這是整個 skill 唯一在本機編 app、開 app 的地方。量測綁定這一輪的 NT：之後 HEAD 有任何變動（修正 commit）就重做這一步。

先讀 fork-verify（`.agents/skills/fork-verify/SKILL.md` 的 Launch、Native AppKit、Cleanup，以及 `features/window-tabs.md`）。和它不同的地方以這裡為準：

- `S=$MAIN/.rebase-review/chrome`，不用 `/tmp/oi-verify`。
- 這個 session 沒有 `mcp__tauri__*`。webview 一律用 `node .agents/skills/fork-verify/scripts/bridge-js.mjs <port> <windowLabel> '<script>'`。
  - 會開對話框的呼叫不要 await。點對話框按鈕寫成 `setTimeout(() => btn.click(), 0)`，不然 bridge-js 回 `null`。
- bridge 狀態用 `node scripts/dev-status.ts` 讀：`pnpm -s` 會多印一行，不是純 JSON。
- 兩個 pid 都要記：
  - `DEV`：`pnpm dev:app` 的 pid，收尾用。用 shell 的 `&` 啟動、`echo DEV=$!` 取得（Bash 工具的背景模式拿不到 pid；`&` 啟動的程序在這次呼叫結束後仍會繼續跑）。
  - `APP`：`pgrep -f "^$MAIN/target/debug/openidea"`，osascript 和 cliclick 用。

真實輸入的寫法（osascript 不能把按鍵送給指定 pid，只能先讓它到最前面）：

```sh
front() { osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $APP) to true" -e 'delay 0.5' -e 'tell application "System Events" to get unix id of (first process whose frontmost is true)'; }  # 印出的 pid 必須等於 APP
osascript -e 'tell application "System Events" to keystroke "f" using {control down, command down}'   # ⌃⌘F
osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP) to get {name, position, size, value of attribute \"AXFullScreen\"} of window 1"
```

每次 osascript、cliclick 或 screencapture 之前先跑 `front`，讀回的 pid 不是 `APP` 就不送。

1. **心跳與啟動**：
   - PR 留言「視窗 chrome 實機檢查開始（本機編譯約 10 分鐘）」。
   - `pgrep -fl target/debug/openidea` 有別的 worktree 的 dev app 在跑，代表別人可能正在用真實輸入，不要搶，也不要停它：每 5 分鐘再查一次，最多等 60 分鐘，每 20 分鐘在 PR 留一則心跳（寫 pid 與路徑）。60 分鐘後還在才交人。agent 與使用者常開 dev app，整點的 run 撞上就交人，等於把這一輪丟回給使用者。
   - `mkdir -p "$S"; cd "$MAIN"; PATH="$HOME/.cargo/bin:$PATH" pnpm dev:app > "$S/dev.log" 2>&1 & echo DEV=$!`（debug 設定照全域 `~/.cargo/config.toml`，不另外覆寫）。
   - 在背景等，最多 30 分鐘：`end=$((SECONDS+1800)); until node scripts/dev-status.ts 2>/dev/null | grep -q '"port"'; do perl -pe 's/\e\[[0-9;]*m//g' "$S/dev.log" | grep -q '^error' && break; [ $SECONDS -gt $end ] && break; sleep 10; done`（cargo 的輸出帶色碼，先去掉再比對）。
   - 編不過或逾時，代表 rebase 結果有問題，交人並附 `$S/dev.log` 尾段。
2. **preflight**：
   - osascript 讀得到 frontmost 程序；`cliclick p:.` 成功。
   - `screencapture -x` 的像素等於螢幕點大小乘 backing scale。點大小用 `osascript -e 'tell application "Finder" to get bounds of window of desktop'` 讀（Mac mini：1920×1080 點，3840×2160 像素）。
   - 螢幕沒鎖定：`swift -e 'import CoreGraphics; let d = CGSessionCopyCurrentDictionary() as? [String: Any]; print(d?["CGSSessionScreenIsLocked"] ?? 0, d?["kCGSSessionOnConsoleKey"] ?? 0)'` 要印 `0 1`（鎖定時第一個是 1；不在 console 上時第二個是 0）。
   - 用 `sips -Z 800` 縮小後 Read 看一眼，不是全黑（顯示器休眠）。
   - 任何一項不過就交人，寫明是哪一項：輔助使用或螢幕錄製權限只有使用者能給。
3. **螢幕是使用者的桌面**：Mac mini 同時開著使用者的其他 app，包括密碼管理器、系統對話框和常駐的通知。
   - 截圖只存在 `$S/`，Read 看完就算，不上傳、不貼進 PR、Bark 或任何對外的地方。
   - 別的 app 的對話框和通知不要動。
   - 只看要用到的區域：要點的位置，以及視窗頂端到 tab row 底部那一條。裁切用 `sips -c <高> <寬> --cropOffset <y> <x> in.png --out strip.png`，單位是像素（點×2）。offset 不可以是 0，0 會被當成置中裁切，所以至少寫 1。點擊位置挑沒被蓋住的地方。
   - 那一條只要有沒被蓋住的一段看得到，就能判斷有沒有原生 tab bar：它會橫跨整個視窗寬。
   - 要點的位置或整條都被蓋住：等 30 秒重拍一次，還是蓋住就交人，寫明被什麼蓋住，但不寫內容。
4. **fixture**：`$S/tabs/{alpha,beta,gamma}` 三個 `git init` 目錄，各有一個 commit（`git -c user.name=ar -c user.email=ar@localhost commit --allow-empty -m init`）。
   - alpha：在 `main` 視窗呼叫 `import("/src/features/app/windows.ts").then(m => { m.openProjectInWindow("<alpha>", true); })`，不要 await：它要等信任才會結束，await 會讓 bridge-js 逾時。信任對話框出現在 `main`，在那裡點 `Trust Project`。
   - beta：在 alpha 的視窗（`project-N`，從 `dev:status` 取）呼叫 `import("/src/features/app/windows.ts").then(m => { m.openProjectWithPolicy("<beta>"); })`，不要 await。Open Project 對話框和信任對話框都出現在呼叫的那個視窗，依序點 `New Tab` 和 `Trust Project`。
   - 沒出現 Open Project 對話框：dev 資料夾的 `general.openProjectIn` 不是 ask。用 fork-verify 的 `settingsSet` 設成 `"ask"` 再開。
5. **檢查**：每一項記下量測值，任何一項不符就是 FAIL。tab row 每個視窗各畫一份，而且都把自己標成 selected，不能拿 DOM 的 `[selected]` 判斷切換。
   - a. 視窗模式。
     - `[role=tablist][aria-label="Project windows"]` 有 2 個 tab。
     - 它的 top ≥ 頁面工具列 `header[class*=_bar_]` 的 bottom（`getBoundingClientRect`）。
     - 截圖上看不到 AppKit 原生 tab bar。
     - 記下 window 1 的 `{position, size}`。
   - b. `front` 後送 ⌃⌘F。
     - `AXFullScreen` 是 true，frame 等於螢幕的點大小。
     - tab row 仍在工具列下方，截圖上沒有原生 tab bar。
   - c. 在全螢幕裡，cliclick 點另一個 tab 的中心（螢幕座標＝視窗原點＋元素 rect 中心）。
     - osascript 讀到的 window 1 名稱換成被點的專案。
     - 再點工具列裡的分支按鈕（`header[class*=_bar_]` 裡的分支名），從 DOM 讀到 `aria-expanded="true"`。
     - 指標的 y 至少 10，碰到螢幕頂端會叫出選單列。實測 y=20 可以點到。
     - 接著送 `key code 53` 關掉選單。
   - d. cliclick 點編輯區裡沒被蓋住的一點，從 DOM 確認 `document.hasFocus()` 是 true，再送 `key code 53`（Escape）。`AXFullScreen` 仍是 true。
   - e. 用 beta 那個寫法，從目前顯示的視窗把 gamma 以 New Tab 加入。從點 `Trust Project` 起每秒讀一次 window 1，5 秒內名稱是 gamma、frame 等於螢幕大小，tab row 有 3 個 tab。第一筆就是螢幕大小也算過：要抓的退化是停在 1440×900。
   - f. 送 ⌃⌘F 退出。window 1 回到 a 記下的 frame，不是可見區域（Mac mini 是 0,30 1920×960）。
6. **結果**：
   - 全部 PASS：確認 `git rev-parse HEAD` 等於 NT（不等就重做這一步），PR 留言第一行寫 `<!-- auto-rebase:chrome-verified <NT> -->`，下面寫 a～f 每項的量測值，再列沒測的項目：
     - 選單列在全螢幕顯示（要改全域 `defaults`，排程不改）
     - 瀏海螢幕
     - 寬視窗存檔加入全螢幕群組（#71）
     - tab 拖曳排序、Move Tab to New Window（全螢幕群組裡移出的視窗退不出全螢幕是既有問題 #352；要加測就放在 f 之後，不然 f 的狀態會亂掉）
     - 關 tab、關整組與未存檔提示（#194、#207、#209）
     - 重啟後還原群組

     然後接第 4 步（3b 交人前來做的，回去留 needs-human，寫「視窗 chrome 已實測」）。

   - 任何 FAIL：交人，附 a～f 的量測值和失敗的那一項。保留路徑不自己修。
7. **收尾**：PASS、FAIL、中途交人都要做，每個出口都跑。
   - 還在全螢幕就先 `front` 再 ⌃⌘F 退出。
   - 停掉 `DEV` 的整棵程序樹（pnpm、tauri、Vite、cargo、app），不用 `pkill` 程序名：`tree() { for c in $(pgrep -P "$1"); do tree "$c"; done; echo "$1"; }; kill $(tree DEV)`（DEV 換成 pid）。
   - `node scripts/dev-status.ts` 確認沒有 bridge、`pgrep -f "^$MAIN/target/debug/openidea"` 沒有輸出；還有殘留就對那些 pid 再 `kill`。
   - `rm -rf "$S"`，截圖一起刪。
   - 刪 `~/Library/Application Support/<dev:status 回報的 identifier>/` 和 `~/Library/Caches/<同一個 identifier>/`。
   - 先量 `$MAIN/target` 再刪。
   - `~/.cargo/targets/` 下的 openidea 專案快取與 `shared-deps` 各自量：任一個超過 6 GiB，就在 `MAIN` 跑 `PATH="$HOME/.cargo/bin:$PATH" cargo build --offline --locked -p ide-core --bins` 觸發 GC。
   - 清理前後的容量寫進第 7 步的細節。
   - 不跑 `cargo clean`，不手動刪 `~/.cargo/targets`。

## 4. 移動 develop

CLEAN、MECHANICAL 先做第 3b 步第 1 點的保留路徑檢查：命中的全是視窗 chrome，就先做第 3c 步再回來；命中其他保留項就交人（下面「不符合條件」那段）。

條件全部成立才移動：模式是 CLEAN 或 MECHANICAL（或 MANUAL 而第 3b 步通過）、第 3b 步第 1 點的保留路徑檢查沒有命中，或命中的全是視窗 chrome 而第 3c 步留了這一輪 NT（＝HEAD）的 chrome-verified（CLEAN、MECHANICAL 也要做這一點：上游改了視窗 chrome，沒衝突也要實機看；從第 0 步 approved 進來的不用）、第 2 步沒有 fork 造成的紅、第 3 步 `Fork CI passed` 綠。上游也紅的 job 不算綠：上游已修就搬它的修正，否則修測試或照 #252 加 filter 並開 issue，都是修正 commit（模式變 MANUAL）。推上去後回第 2、3 步，再進第 3b 步（加 filter 屬於削弱閘門，只有符合第 3b 步第 1 點「上游也紅的測試」例外時不交人）。從第 0 步 approved 進來的不做這段修正：PR 說明已列為上游也紅、使用者核可過的 job 照第 0 步的規則放行，推修正 commit 會讓核可作廢。從第 0 步 approved 進來的，使用者的核可取代模式條件。

`git rev-parse fork/develop` 已經等於 HEAD（使用者自己移過，或前一次 run 推完還沒留言就死了）→ 不推，直接留 develop-moved 留言。否則：

```sh
git push --force-with-lease=develop:OLD_DEVELOP fork HEAD:develop
```

lease 失敗（develop 在這期間合進了別的 PR）→ HEAD 不在 `fork/develop` 或 `fork/backup/*` 上就先 `git push fork "HEAD:refs/heads/backup/rebase-vNEW-$RUN"`（從 approved 進來的 HEAD 含使用者審過的解法），再 PR 留言說明後關閉、刪 `rebase/vNEW` 與 `ci-base/vNEW`，通知「下一次 run 從新的 develop 重來」，結束。成功 → PR 留言 `<!-- auto-rebase:develop-moved <HEAD 完整 sha> -->`。

develop 一移動（含已在 HEAD 不重推的情況）就列出這次 rebase 帶進 develop 的 workflow：`git diff --diff-filter=A --name-only OLD_DEVELOP <develop sha> -- .github/workflows/`，`<develop sha>` 在這裡是 HEAD。兩端都用 sha、不用 vOLD／vNEW：tag 可變（上游改過 v0.1.37 的 tag，第 0 步會強制更新 tags），恢復時重新解析會漏列。`gh workflow list -R audichuang/openidea --all --json path,state,name` 裡 path 在這份清單、state 是 active 的，照 FORK.md 馬上 `gh workflow disable`，寫進通知。只比對這份路徑清單：fork 自己的 workflow（包括已刪分支留下的 `zz-*` 註冊）也是 active、名稱也不是 Fork CI，用名稱篩會誤停。`pull_request_target` 從 PR 的 base 分支讀 workflow，develop 一動，下一個對 develop 開的 PR 就會觸發它（v0.1.35 的 `PR check` 幾秒內就在 PR 上貼了 needs-info）。清單裡還沒出現的，第 6 步移動 main 後再查一次。接第 5 步。

不符合條件（MANUAL 而自審沒通過、碰到必交人路徑、第 3c 步沒過或做不了，或有修不掉的紅）→ 不移動，PR 留言 `<!-- auto-rebase:needs-human -->` 加上要使用者看什麼（自審做到哪、卡在哪），只寫使用者才能決定或才做得到的事：要他看的每一項都說明為什麼排程自己做不了（保留路徑、權限、判斷不了的產品取捨）。「請看這幾個修正 commit」「這個解法對不對」這類技術複核不列，交人前照第 3b 步第 5 點「交人」審完。這份 skill 或流程本身的缺口（規則沒有出口、字面和實際對不上）不拿來問使用者：照比較保守的判讀做完這一輪，`gh issue create -R audichuang/openidea` 開 issue 記下缺口與這次採用的判讀，編號寫進細節。最後一段固定寫交回方法：看完沒問題就另留一則第一行是 `<!-- auto-rebase:approved <HEAD 完整 sha> -->` 的留言，下一次排程（每小時 :37）會移動 develop 並發版。不要給使用者手動 lease 推送或發版的指令。跳第 7 步。

## 5. 對 develop 開著的 PR

`gh pr list -R audichuang/openidea --base develop --state open`：每個 PR 的分支都還在舊基底上，留言請它照 FORK.md 用 `git rebase --onto fork/develop <舊 merge-base>` 搬過來。不要替它搬。

## 6. 發版

1. 先查要發的 sha 是否已有 tag：`git ls-remote --tags fork "refs/tags/vNEW-fork.*"` 裡有指向它的（annotated tag 看 `^{}` 那行），代表前一次 run 推完 tag 後死了：沿用那個 tag，先做第 3 點結尾的 workflow 檢查（前一次 run 可能死在 disable 之前），再跳到第 4 點看它的 fork-release run（失敗就 `gh run rerun <id>`；找不到這個 tag 的 run 就寫進通知交人；fork-release 也會在 develop push 與每週排程跑候選版，那些 run 不算這個 tag 的發版），不要再發新 N。沒有才算 N：最大的 N 加一，沒有就 1。
2. 寫 release notes（繁體中文，使用者看得到的變化；不寫 commit 雜訊）存成 `$MAIN/.rebase-review/notes.md`：
   - 第一行：`基於上游 vNEW（上一版基於 vOLD）`
   - 上游這次的重點：讀 `gh release view <tag> -R l0ng-ai/openidea --json body` 裡 vOLD 之後到 vNEW 的每一版，挑使用者看得到的改動，每項一行
   - fork 這次的改動：拿 `git log --format=%s vNEW..HEAD` 和上一個已發布的 fork release（只有 tag、沒有 Release 的不算）的 `git log --format=%s <它的上游基底>..<tag>` 比，標題是新的才列；都沒有就寫「fork 功能無變更，只跟上上游」
   - 第 3b 步列為已知問題的，每個一行，附 issue 編號；沒有就不寫這段
   - 第 3b 步用 fork 開關維持 OT 行為或關掉入口的上游功能，每個一行，附 issue 編號；沒有就不寫這段
   - 這次 rebase 的模式與衝突一句話；第 3b 步放行的寫「MANUAL，自審通過」；有第 3c 步的接「視窗 chrome 已在 Mac mini 實測（瀏海螢幕未測）」，沒有的接「未實機測試」
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

1. 結果一句：跟上哪一版上游、模式（自審放行的寫「MANUAL，自審通過」，再接「視窗 chrome 已實測」或「未實機測試」）；沒發版就寫為什麼（必交人路徑、自審 finding、chrome 實測沒過、哪一步紅、lease 失敗）
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
- 不在本機編 Rust（Mac mini 磁碟），不安裝或更新 app、不開 app。唯一例外是第 3c 步的 `pnpm dev:app`，做完照它的收尾清掉。
