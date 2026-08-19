# 決策：試務（affair）整條屬於 CF，**不在這個 repo**

> **裁示日期**：2026-08-19
> **狀態**：已定案。⚠️ 這個 repo 的 affair 路由是**待刪的孤島**，⛔ 不是待補齊的功能。

## 一句話

**學校／縣市交試務資料，全部在 CF（`exam-control`）上：在 CF 登入、資料存 CF D1。**
⇒ 這個 repo（院內 `exam-server`）的 affair 路由**不會有使用者**。

## 🔴 為什麼不可能放在這個 repo —— 三個獨立成立的理由

### ① 這台機器對外不可達，而且**設計上就不該可達**

實測（2026-08-19）：`ss -ltnp` ⇒ `LISTEN 127.0.0.1:18787`。
⇒ 從任何其他位址都連不到。

而部署腳本 `deploy/scripts/bootstrap-almalinux10.sh:47` 逐字：

```
SF_HOST="${SF_HOST:-127.0.0.1}"   # ⚠️ 正式機要改成 WireGuard 介面位址，絕不可填 0.0.0.0
```

⇒ 也就是說：**正式環境的目標狀態也不是對外**，是「只在隧道內」。

### ② 隧道是「一台機器一台核准」，**擴不到幾百所學校**

桌面版連進來要先在 `wg_device_enrollments` 登記、再由平台管理員在 `/li41` 逐台核准。
⇒ 那個流程是給**院內職員的機器**設計的。
🔴 幾百所學校逐台核准不可行，而**放寬核准就等於放棄這條線的信任模型**。

### ③ CF 那側的試務資料層**早就蓋好了**

`exam-control/migrations/`：

```
0034_exam_affairs   0035_..._cities_fields   0036_..._schools   0037_..._collections
0039_..._excel_field_bindings   0040_..._ref_data   0041_..._submissions   0055_..._settings
```

⚠️ `0041` 的 `exam_affair_submissions` 有 `submitter_type IN ('school','city')` ＋ 互斥的
`school_id` / `city_id` ⇒ **它本來就是為「學校或縣市自己交件」設計的**。

## ✅ 而「拔掉這個 repo 的 affair」是安全的 —— 已查證

2026-08-19 查 `origin/main`：那四個檔（`affair-routes` / `affair-submission-routes` /
`affair-configuration-routes` / `affair-receipt-routes`）**只被 `apps/api/src/server.ts` 掛載**，
⛔ 沒有任何業務程式讀它們的資料表。

⚠️ **施測與題庫完全不碰 affair** ⇒ 那四個檔是孤島。

⚠️ 誠實邊界：上面是**快掃**（`git grep` 排除 affair 自身檔名）。
⇒ 逐檔清點（含測試、含資料表被誰讀）在 `exam-server#80` 進行中，**刪除要等那份輸出**。

## ⚠️ 已知的一個歷史缺陷（刪掉之後自然消失）

`exam-server#82`：`affair-submission-routes.ts` 的 `ensureSubmission()` 從 **request body**
取 `school_id` / `city_id`，而 scope 只有 tenant ⇒ 同租戶身分可碰別家 submission。

🔴 **但它今天不可達**（無呼叫端 ＋ 服務不對外）。
⇒ 而它的正確修法**不是補一道檢查** —— 是連整組路由一起刪掉。

⚠️ 那個 issue 的交件者停手時說得對：「**沒有可信的 caller principal**」。
⇒ 根因是「這條路的使用者根本還沒被決定」，⇒ **當一個「缺陷」的修法需要先決定使用者是誰，那它就不是缺陷。**

## ⛔ 這份文件不足以防止重犯，所以另有一道閘門

`scripts/check-affair-scope.mjs`：affair 路由檔數**只准變少**（棘輪）。
⇒ 新增一個 affair 路由檔 ⇒ **verify 紅**，訊息指向本文件。

⚠️ 理由：**散文會過期而不會紅。** 本專案 2026-08-19 一天內發現四次
「把不變式的維持責任交給人的記憶」而失效的實例，⇒ 這裡不重複那個錯。
