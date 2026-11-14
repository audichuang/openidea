# Git Log 效能回歸

開發中可在同一台機器比較基底與變更。先測基底，再切到變更版本重跑。兩次應使用相同的瀏覽器、顯示設定和跑法。

```sh
pnpm perf --only gitLog,gitLogScrollbar,gitLogWide --skip-bundle --runs 5 --save-baseline
pnpm perf --only gitLog,gitLogScrollbar,gitLogWide --skip-bundle --runs 5 --fail-on-regression
```

- `gitLog` 檢查首筆提交、方向鍵與滾輪。
- `gitLogScrollbar` 檢查已載入大量提交時的大幅捲動。
- `gitLogWide` 檢查 240 條長分支同時跨過多列，並確認實際載入至少八頁。最長畫面間隔與總阻塞時間能揭露 P95 看不到的少數長停頓。

這些情境使用固定的模擬 Git 回應。修改 Git 查詢、快取、差異讀取或 IPC 時，也在桌面開發版用固定的真實 repo 測首筆結果。記錄首次查詢與重開各自的時間，再量提交列表是否卡住。檔案歷史、選取範圍歷史和差異預覽應各自走到第一筆可見內容。改動可能影響互動時，用多輪實測和 trace 確認退步能重現。
