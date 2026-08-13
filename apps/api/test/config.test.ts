import { describe, expect, it } from "vitest";
import { defaultFileCleanupIntervalMs } from "@server-foundation/local-fs-storage";
import { loadConfig } from "../src/config.js";

describe("server config", () => {
  it("uses safe development defaults", () => {
    expect(loadConfig({})).toEqual({
      nodeEnv: "development",
      production: false,
      host: "127.0.0.1",
      port: 8787,
      mysqlUrl: undefined,
      redisUrl: undefined,
      fileStorageRoot: undefined,
      fileCleanupIntervalMs: defaultFileCleanupIntervalMs,
      idempotencyTtlSeconds: 86_400,
      trustProxyHeaders: false,
      shutdownTimeoutMs: 30_000,
    });
  });

  it("parses explicit operational settings", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "9443",
        MYSQL_URL: "mysql://app:secret@127.0.0.1:3306/app",
        REDIS_URL: "rediss://127.0.0.1:6380",
        FILE_STORAGE_ROOT: "/srv/private-files",
        FILE_CLEANUP_INTERVAL_SECONDS: "120",
        IDEMPOTENCY_TTL_SECONDS: "3600",
        TRUST_PROXY_HEADERS: "true",
        SHUTDOWN_TIMEOUT_SECONDS: "20",
      }),
    ).toMatchObject({
      nodeEnv: "production",
      production: true,
      host: "127.0.0.1",
      port: 9443,
      fileCleanupIntervalMs: 120_000,
      idempotencyTtlSeconds: 3600,
      trustProxyHeaders: true,
      shutdownTimeoutMs: 20_000,
    });
  });

  it("requires all production backing services", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      /MYSQL_URL, REDIS_URL, and FILE_STORAGE_ROOT/,
    );
  });

  it("rejects Redis without MySQL", () => {
    expect(() => loadConfig({ REDIS_URL: "redis://127.0.0.1:6379" })).toThrow(
      /MYSQL_URL is required/,
    );
  });

  it("rejects ambiguous booleans and invalid operational settings", () => {
    expect(() => loadConfig({ TRUST_PROXY_HEADERS: "1" })).toThrow(
      /TRUST_PROXY_HEADERS/,
    );
    expect(() => loadConfig({ PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ HOST: "https://127.0.0.1" })).toThrow(/HOST/);
    expect(() => loadConfig({ IDEMPOTENCY_TTL_SECONDS: "30" })).toThrow(
      /IDEMPOTENCY_TTL_SECONDS/,
    );
  });

  it("does not treat the string false as true", () => {
    expect(loadConfig({ TRUST_PROXY_HEADERS: "false" }).trustProxyHeaders).toBe(
      false,
    );
  });
});
