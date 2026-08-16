# PHP parity contracts

## #41 Question media integrity

PHP 題庫把題目圖片保存為路徑字串，沒有 exam-server `fileId` / tenant-aware file metadata 的完整性約束。exam-server 刻意維持較嚴格的媒體關聯契約：

- 題目建立或更新時，media `fileId` 必須指向同一 tenant、`ready` 且未刪除的檔案；不存在、已刪除、未完成或屬於其他 tenant 都以同一種「不存在」錯誤拒絕，避免洩漏跨 tenant 檔案存在性。
- 題目讀取不會把孤兒 relation 靜默丟掉。media result 保留 `fileId`，並以 `available: false` 明確表示檔案已不可用；`media: []` 才代表題目本來沒有媒體。
- 刪除檔案採「拒絕刪除」而不是自動清題目 relation。呼叫者可先用 `GET /api/v1/questions?fileId=...` 查出同 tenant 仍在引用該檔案的 active questions，解除引用後再刪檔。

選擇拒絕刪除是為了避免一個檔案操作暗中改寫題目內容；同時保留可查詢的影響範圍，讓管理端能明確決定先修改哪些題目。
