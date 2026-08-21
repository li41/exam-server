# Server tunnel bring-up

Issue: `#103 WO-SERVER-TUNNEL-BRINGUP`

這份文件只記錄 **repo 端**的 WireGuard 啟動契約。實機安裝、把介面拉起來、`wsl --terminate ExamServer` 後的開機存活驗收由 owner 執行；本變更不宣稱「隧道已建立」或「server-foundation 已啟動」。

## 選擇：甲，使用 `wireguard-go`

本單選 **甲：userspace WireGuard**，不換 WSL custom kernel。

理由：

- `wg-quick` 的 Linux 實作在 `ip link add ... type wireguard` 失敗時，本來就會尋找 `wireguard-go` 作 userspace fallback；因此 kernel 與 userspace 兩條路仍可共用 `wg-quick@wg0.service`。
- 不換 `.wslconfig` kernel，不會把同一台 Windows 上其他 distro 一起綁到自訂核心，回退面較小。
- `wireguard-go` 只在 kernel probe 無法建立 WireGuard interface 時安裝；版本固定為 `0.0.20250522`，由 upstream tagged source build，不追 floating `latest`。
- userspace 路徑的吞吐與實際 WSL 相容性尚未在 `ExamServer` distro 實測；若 owner 實測吞吐不足，再另行評估 custom kernel，不在本單預先擴大範圍。

`boringtun-cli` 沒有被選為本單實作。若未來改用它，非互動 shell 已知會遇到 `DropPrivileges("NULL from getlogin")`；那不是「權限不足」，而是 drop-privileges 本身取不到 login identity，必須使用 `--disable-drop-privileges`。同一警語也留在 bootstrap 原始碼註解。

## Fail closed：隧道失敗就是 bootstrap 失敗

`deploy/scripts/bootstrap-almalinux10.sh` 不再把 `wg-quick` 啟動失敗降級成 warning。

預設 `SF_SETUP_WIREGUARD=1` 時：

1. 安裝 `wireguard-tools`。
2. probe kernel 是否能建立 WireGuard interface。
3. kernel 不支援時確認 `/dev/net/tun` 可用，並安裝 pinned `wireguard-go` userspace fallback。
4. `SF_WG_TUNNEL_UNIT`（預設 `wg-quick@wg0.service`）必須 enable/start 成功。
5. `wg show wg0` 必須能看到該 interface；否則 bootstrap 以非 0 結束，錯誤會明講「隧道未建立、server-foundation 將無法啟動」。

`SF_SETUP_WIREGUARD=0` 仍是明確的 test/dev skip；它不是預設，也不會被寫成「隧道通過」。

## server-foundation 必須排在隧道後

`deploy/systemd/server-foundation.service` 同時服務 repo 既有的 Caddy/loopback baseline，因此不能在 base unit 無條件 hard-code WireGuard dependency。

WireGuard bootstrap 會在安裝時建立：

```text
/etc/systemd/system/server-foundation.service.d/10-tunnel.conf
```

內容等價於：

```ini
[Unit]
After=wg-quick@wg0.service
Requires=wg-quick@wg0.service
```

實際 unit 名取自 `SF_WG_TUNNEL_UNIT`，避免未來 userspace backend 若改成獨立 unit 時還得改 base service。當 `SF_SETUP_WIREGUARD=0` 重跑時，bootstrap 會移除這個 drop-in，避免破壞原本 loopback/Caddy deployment mode。

這只建立 **repo 端的 ordering/requirement 契約**。是否真的能在 `wsl --terminate ExamServer` 後自動回到 active，必須由 owner 在實機驗收。

## 金鑰：預設保留，只有明確旗標才輪替

預設重跑 bootstrap **不覆蓋** `/etc/wireguard/server.key`、`server.pub` 或既有 peer 名冊。

要處理 #103 所述的 8/20 實驗殘留時，明確使用：

```bash
SF_WG_ROTATE_KEYS=1 bash deploy/scripts/bootstrap-almalinux10.sh
```

這條路會：

- 刪除舊 `probe.key` / `probe.pub` 與舊 `server.key` / `server.pub`；
- 產生新的 server key pair；
- 若 `wg0.conf` 已存在，只替換 `[Interface]` 的 `PrivateKey`，**保留既有 `[Peer]` 區塊**；
- restart tunnel unit，避免磁碟上的新 key 與仍在記憶體中的舊 interface key 不一致。

私鑰不應出現在 PR、commit、issue、shell argv 或 log。

### 🔴 WireGuard 狀態檢查通則

**永遠不要使用：**

```text
wg show <iface> dump
```

`dump` 的第一欄包含 private key，曾經實際造成私鑰外洩並必須換 key。要看狀態只用：

```text
wg show
```

或針對單一介面使用不帶 `dump` 的 `wg show wg0`。

## 本單確認成立的 repo 前提

- current `main` 的 bootstrap 原本確實在 `wg-quick@wg0` 失敗時只 `warn`，因此「正式機必須成功」與退出碼脫鉤；本單改成 fail closed。
- `scripts/sync-wireguard-peers.mjs` 與 `scripts/sync-wireguard-peers.test.mjs` 都存在；本單沒有重寫同步器。
- current base `server-foundation.service` 只有 network ordering，沒有 tunnel dependency；本單由 bootstrap 安裝 conditional drop-in。
- repo 內查不到 `100.74.241.127` 或 Windows firewall `100.64.0.0/10` 的獨立證據；這兩項仍只能視為 #103 提供的 owner-side operational fact，本單沒有冒充 repo 已驗證。

## 本單無法驗證的部分

以下都 **不是 PASS**：

- `ExamServer` WSL kernel 的 `ip link add ... type wireguard` 實際失敗形狀；本執行環境沒有那台 WSL。
- 該機 `/dev/net/tun` 是否可供 `wireguard-go` 使用。
- AlmaLinux 10 目標機實際下載／編譯／執行 `wireguard-go 0.0.20250522`。
- `wg-quick@wg0.service` 在 userspace fallback 下是否真的 active、`wg0` 是否真的有 `10.99.0.1`。
- `server-foundation` 是否真的能綁 `10.99.0.1:18787`。
- `wsl --terminate ExamServer` 後 MySQL／Valkey／WireGuard／server-foundation 是否全部自行回到 active，以及 18787 是否自行恢復監聽。
- Windows firewall UDP 51820 與 Tailscale endpoint `100.74.241.127` 的實機狀態。
- N-1 migration rollback、listener boundary、cold-boot acceptance、MySQL integration 與 backup restore 等本來就需要 owner/真實環境的 gates。

本單不 SSH、不碰 secret、不查或修改遠端資料庫，也不執行完整 `corepack pnpm verify`、Prettier 或 tsc。