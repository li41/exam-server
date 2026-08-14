/**
 * ⚠️⚠️ **這個資料夾裡的整合測試不可以平行跑。**
 *
 * 本檔與同資料夾其他 `*.integration.test.ts` **共用同一個 `REDIS_TEST_URL`**，
 * 而且每個檔都會 `flushDb()` 洗掉整個 DB。vitest 預設平行跑檔案 ⇒
 * **後 flush 的會把先跑那個的 key 洗掉**，失敗的一方隨機。
 *
 * 2026-08-14：這個競態讓 CI 從 08-13 起一直紅，而且因為
 * `test:integration` 第一個失敗就停，**後面的 API 整合、N-1 migration 閘門、
 * 備份還原演練三道全部被跳過**——是「一條 flaky 測試擋掉三道關卡」。
 *
 * ⇒ `package.json` 的 `test:integration` 因此釘著 **`--no-file-parallelism`**。
 * ⚠️ **不要拿掉那個旗標**，也不要改用會平行的跑法。
 *
 * ⚠️ **要新增第三個整合測試檔的人請注意**：只要你也 `flushDb()`，
 * 這個約束就同樣適用。**更穩健的做法是不要 `flushDb()`，改成只清自己的 key 前綴**——
 * 那樣就不必依賴這個旗標。
 */
import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import { RedisIdempotencyStore } from "../src/index.js";

const connectionString = process.env.REDIS_TEST_URL;
const suite = connectionString ? describe : describe.skip;

suite("RedisIdempotencyStore", () => {
  it("reserves, detects conflicts, completes, and replays responses", async () => {
    const client = createClient({ url: connectionString });
    await client.connect();
    await client.flushDb();
    const store = new RedisIdempotencyStore(client);

    await expect(
      store.reserve("tenant-a:POST:/api/items", "key-1", "hash-a", 60),
    ).resolves.toEqual({ state: "acquired" });
    await expect(
      store.reserve("tenant-a:POST:/api/items", "key-1", "hash-a", 60),
    ).resolves.toEqual({ state: "pending" });
    await expect(
      store.reserve("tenant-a:POST:/api/items", "key-1", "hash-b", 60),
    ).resolves.toEqual({ state: "conflict" });

    await store.complete(
      "tenant-a:POST:/api/items",
      "key-1",
      "hash-a",
      {
        status: 201,
        body: JSON.stringify({ id: "item-1" }),
        contentType: "application/json",
      },
      3600,
    );

    await expect(
      store.reserve("tenant-a:POST:/api/items", "key-1", "hash-a", 60),
    ).resolves.toEqual({
      state: "completed",
      response: {
        status: 201,
        body: JSON.stringify({ id: "item-1" }),
        contentType: "application/json",
      },
    });

    await expect(
      store.reserve("tenant-a:POST:/api/items", "key-2", "hash-a", 60),
    ).resolves.toEqual({ state: "acquired" });
    await store.release("tenant-a:POST:/api/items", "key-2", "hash-a");
    await expect(
      store.reserve("tenant-a:POST:/api/items", "key-2", "hash-a", 60),
    ).resolves.toEqual({ state: "acquired" });

    await client.flushDb();
    await client.quit();
  });
});
