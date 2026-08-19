# N-1 migration rollback 本機驗證

`scripts/check-migration-rollback-compatibility.mjs` 會把目前 schema migration 套到一個暫時資料庫，再用 N-1 application revision 跑 integration tests，驗證「只回滾程式、不回滾資料庫」仍可行。

## Base ref

CI 仍以 `ROLLBACK_BASE_REF` 為準。本機沒有設定時，腳本會嘗試使用：

```text
git merge-base origin/main HEAD
```

成功時輸出會明確列出實際 commit；解析不到 `origin/main`／merge-base 時才走 verify skip ledger，這不算通過。

若要手動指定特定 revision，仍可：

```bash
ROLLBACK_BASE_REF=<commit-or-ref> corepack pnpm migration:rollback-compatibility
```

顯式設定永遠優先於本機推導，而且無效 ref 會直接失敗。

## `MYSQL_TEST_URL` 必須使用專用測試帳號

⛔ **不要把正式應用帳號 `server_foundation` 加上 `CREATE DATABASE`／`DROP DATABASE`。**

這個 gate 會從 `MYSQL_TEST_URL` 的 database 名稱推導隔離庫：

```text
<原庫>_nminus1_<pid>
```

例如 `MYSQL_TEST_URL` 指向 `server_foundation_test`，實際暫存庫會像：

```text
server_foundation_test_nminus1_12345
```

因此本機／測試機應建立一個**只允許操作這個 prefix** 的專用帳號。它不應取得其他 database 的權限，也不應取代 application account。

### MySQL 8.4 範例

下面以 base database `server_foundation_test`、測試帳號 `server_foundation_nminus1` 為例。`REPLACE_WITH_LOCAL_SECRET` 只是佔位字，實際密碼必須留在本機 secret 管理方式中，**不可 commit**。

先確認資料庫層 wildcard grant 的語意可用：

```sql
SHOW VARIABLES LIKE 'partial_revokes';
```

此做法要求 `partial_revokes=OFF`。若是 `ON`，不要改成全域 `CREATE`／`DROP` 來繞過限制；應改用隔離的測試 MySQL 或另行設計測試庫 provisioner。

建立只允許本機來源的帳號：

```sql
CREATE USER 'server_foundation_nminus1'@'127.0.0.1'
  IDENTIFIED BY 'REPLACE_WITH_LOCAL_SECRET';
CREATE USER 'server_foundation_nminus1'@'localhost'
  IDENTIFIED BY 'REPLACE_WITH_LOCAL_SECRET';
```

授權只給 `server_foundation_test_nminus1_%`。`_` 在 database-level `GRANT` pattern 內是 wildcard，所以 prefix 裡原本的 underscore 要寫成 `\_`；最後一個 `%` 才是刻意保留的 suffix wildcard：

```sql
GRANT ALL PRIVILEGES
  ON `server\_foundation\_test\_nminus1\_%`.*
  TO 'server_foundation_nminus1'@'127.0.0.1';
GRANT ALL PRIVILEGES
  ON `server\_foundation\_test\_nminus1\_%`.*
  TO 'server_foundation_nminus1'@'localhost';
```

這是 database scope 的 `ALL PRIVILEGES`，不是 global `*.*`；目的是讓 migration/integration test 能在自己的暫存庫內建表、改表、讀寫與最後刪庫，同時不碰正式庫或其他測試庫。

用 `SHOW GRANTS` 複核：

```sql
SHOW GRANTS FOR 'server_foundation_nminus1'@'127.0.0.1';
SHOW GRANTS FOR 'server_foundation_nminus1'@'localhost';
```

⚠️ MySQL 8.4 已把 database-name wildcard grants 標為 deprecated。現階段這是為了符合 `<原庫>_nminus1_<pid>` 動態庫名而採用的受限方案；未來若 MySQL 移除此行為，應改造測試庫 provisioner，⛔ 不要把應用帳號或測試帳號升成全域建／刪庫權限。

## 執行

把密碼只放在本機環境／secret manager，`MYSQL_TEST_URL` 的 database 部分要與上面授權的 prefix 一致。例如：

```bash
export MYSQL_TEST_URL='mysql://server_foundation_nminus1:<URL_ENCODED_LOCAL_SECRET>@127.0.0.1:3306/server_foundation_test'
corepack pnpm migration:rollback-compatibility
```

本機若沒有另外設定 `ROLLBACK_BASE_REF`，輸出應看到類似：

```text
ROLLBACK_BASE_REF not set; using local base from git merge-base origin/main HEAD: <commit>.
```

測完後移除該 shell 的 secret：

```bash
unset MYSQL_TEST_URL
```
