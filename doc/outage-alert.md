# 外部 outage monitoring / alerting

這一層採 **dead man's switch**：server 每 5 分鐘向外部 Healthchecks.io check 送一次 heartbeat。
只有本機 `/health/ready` 回報 `status=ok`，且 `mysql`、`redis`、`storage` 三個 check 全部是 `ok` 時才送 success。

這個形狀刻意不從外面打 API，也不開任何 inbound port。主機斷電、kernel panic、網路中斷、systemd 沒起來時，heartbeat 自然消失；判定 Down 與通知是在外部服務完成，所以不依賴故障主機自己求救。

## 外部先建立什麼

在 Healthchecks.io 建一個 production check，例如 `exam-server-prod`：

- Schedule：Simple。
- Period：**5 minutes**。
- Grace Time：**10 minutes**。
- Notifications：至少接兩個獨立 integration，例如 email + team chat / SMS / PagerDuty。

預設意義是：最後一個 success heartbeat 後，約 5 分鐘進入 Late，再等 10 分鐘 Grace；約 15 分鐘沒有 heartbeat 才進 Down。以本機每 5 分鐘跑一次換算，約等於連續漏掉 3 次 heartbeat 才告警。

門檻是在外部 check 設定，所以可以依營運需求調整，不需要改 API。若要改本機 heartbeat 頻率，也要同步調整 `server-foundation-outage-heartbeat.timer`，避免 Period 小於實際 heartbeat 間隔造成假警報。

Healthchecks 官方文件：

- https://healthchecks.io/docs/
- https://healthchecks.io/docs/configuring_checks/
- https://healthchecks.io/docs/signaling_failures/
- https://healthchecks.io/docs/monitoring_cron_jobs/

建立完成後，複製該 check 的 **Ping URL**。Ping URL 本身視同 secret；不要貼進 issue、PR、shell argv 或 log。

## 安裝

先完成主 server bootstrap，再執行：

```bash
bash deploy/scripts/install-outage-alert.sh
```

第一次會建立：

```text
/etc/server-foundation/outage-alert.env
```

權限固定為：

```text
0600 root:root
```

若仍有 `HEALTHCHECKS_PING_URL=CHANGE_ME`，installer 只安裝 binary、systemd service/timer，但刻意不啟用 timer。

填入 Ping URL：

```bash
sudoedit /etc/server-foundation/outage-alert.env
```

內容：

```dotenv
HEALTHCHECKS_PING_URL=https://hc-ping.com/<你的-check-uuid>
OUTAGE_HEALTH_TIMEOUT_SECONDS=10
OUTAGE_PING_TIMEOUT_SECONDS=10
OUTAGE_PING_RETRIES=3
```

再重跑 installer：

```bash
bash deploy/scripts/install-outage-alert.sh
```

它會 enable timer，並立即跑一次 heartbeat。設定檔是資料型讀取，不會 `source` shell；Ping URL 也不會出現在 process argv。

## 正常行為

systemd 每 5 分鐘執行：

```text
/usr/local/sbin/server-foundation-outage-heartbeat
```

腳本會從既有 `/etc/server-foundation/server-foundation.env` 讀 `HOST` / `PORT`，檢查：

```text
http://<HOST>:<PORT>/health/ready
```

必須同時滿足：

```json
{
  "status": "ok",
  "checks": {
    "mysql": { "status": "ok" },
    "redis": { "status": "ok" },
    "storage": { "status": "ok" }
  }
}
```

才送 success heartbeat。這支工具只讀現有 listener 設定，**不修改 HOST、PORT、WireGuard 或 firewalld**。

查看 timer / journal：

```bash
sudo systemctl status server-foundation-outage-heartbeat.timer --no-pager
sudo journalctl -u server-foundation-outage-heartbeat.service -n 50 --no-pager
```

## 怎麼確認「真的會叫」

### 1. 立即測通知管道

Healthchecks 支援 failure signal。本工具提供顯式測試模式：

```bash
sudo /usr/local/sbin/server-foundation-outage-heartbeat --test-alert
```

它不會先探本機 health，而是直接向同一個外部 check 送 `/fail`。確認 email / chat / SMS 等實際收到 outage 通知後，讓 check 回復 Up：

```bash
sudo /usr/local/sbin/server-foundation-outage-heartbeat
```

正常 heartbeat 只有在 `/health/ready` 三格全綠時才會送出。

### 2. 真正測 dead man's switch

這個測試不必停 API，只暫停 heartbeat timer：

```bash
sudo systemctl stop server-foundation-outage-heartbeat.timer
```

依預設門檻等待超過 15 分鐘，確認外部服務因「沒有 heartbeat」而告警。完成後立刻恢復：

```bash
sudo systemctl start server-foundation-outage-heartbeat.timer
sudo /usr/local/sbin/server-foundation-outage-heartbeat
```

這一項才直接證明「主機完全沒聲音」時，告警決策不依賴本機 process。

## 通知或 heartbeat 本身失敗時會怎樣

### 本機 API / MySQL / Valkey / storage 不健康

不送 success heartbeat，腳本非 0 結束。只要外部 Healthchecks 與通知 integration 正常，超過 Period + Grace 後會告警。

### 本機送不到 Healthchecks

heartbeat HTTP request 預設最多嘗試 3 次，每次 10 秒 timeout；全部失敗後 service 非 0，journal 只記通用錯誤，不印 Ping URL。

如果原因是本機 DNS、路由、ISP 或整台主機失聯，外部 Healthchecks 同樣會因沒有收到 heartbeat 而在門檻後告警。也就是「送不出去」本身通常會轉成 missed-heartbeat signal，而不是被當成成功。

### Healthchecks.io 自己故障

這是此最小方案仍存在的外部單點：如果 Healthchecks.io 本身同時無法判定 check 與投遞通知，它不能替自己告警。至少配置兩個不同 notification integrations 可以降低「其中一條投遞管道壞掉」的風險，但不能消除 Healthchecks 服務本身的故障域。

若未來的 RTO / 可用性要求更高，再增加第二個獨立 dead-man provider 或自管在另一個故障域的 Healthchecks instance；第一批院內使用者先不引入第二套監控平台。

## 真機仍需驗收

repo 測試使用 fake HTTP response 驗證 success / withheld heartbeat / failure signal，不等於真帳號與真通知整合。

正式上線前仍要完成：

1. 建立真 Healthchecks check，Period 5m / Grace 10m。
2. 至少兩個通知 integrations。
3. 執行 `--test-alert`，確認維運者真的收到通知。
4. 停 timer 超過 15 分鐘，確認 missed heartbeat 真的告警。
5. 恢復 timer 並確認 check 回 Up。
