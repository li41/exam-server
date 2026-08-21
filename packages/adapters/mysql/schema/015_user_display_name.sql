-- 建立者姓名（#98 A-6）。
--
-- PHP 的題庫清單與檢視頁畫的是 `users.name`
-- （exam.tw/src/Models/Question.php:899-906、src/Pages/Manage/questionViewView.php:67），
-- 且 PHP 那欄本來就是 `varchar(100) NULL COMMENT '姓名'`，畫面用 `?? '-'` 兜底
-- （exam.tw/config/db/exam_tw_full.sql:65038）。
-- ⇒ 這裡照同樣的形狀：可為 NULL，沒填就不顯示，⛔ 不用 email 遞補（email 是個資，PHP 也不畫）。
--
-- N-1 相容：只加一個可為 NULL 的欄位，舊版程式的 INSERT/SELECT 都不含它，
-- 因此舊版 application 對新 schema 仍可運作（doc/nminus1-migration-rollback.md）。
ALTER TABLE users
  ADD COLUMN display_name VARCHAR(100) NULL AFTER email;
