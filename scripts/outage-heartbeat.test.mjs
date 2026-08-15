import assert from "node:assert/strict";
import test from "node:test";
import {
  healthUrlFromServerEnv,
  normalizePingUrl,
  parseDataEnv,
  runHeartbeat,
  signalUrlFor,
  validateReadiness,
} from "./outage-heartbeat.mjs";

test("parseDataEnv is data-only and rejects duplicate keys", () => {
  assert.deepEqual(parseDataEnv("A=one=two\nB=three\n"), {
    A: "one=two",
    B: "three",
  });
  assert.throws(() => parseDataEnv("A=1\nA=2\n"), /duplicate env key/u);
});

test("ping URL must be configured and use HTTPS", () => {
  assert.throws(() => normalizePingUrl("CHANGE_ME"), /not configured/u);
  assert.throws(() => normalizePingUrl("http://example.test/check"), /https/u);
  assert.equal(
    normalizePingUrl("https://hc-ping.com/example/").href,
    "https://hc-ping.com/example",
  );
});

test("health URL follows server HOST and PORT without changing the boundary", () => {
  assert.equal(
    healthUrlFromServerEnv({ HOST: "10.99.0.1", PORT: "18787" }).href,
    "http://10.99.0.1:18787/health/ready",
  );
});

test("readiness requires mysql, redis, and storage to all be ok", () => {
  validateReadiness({
    status: "ok",
    checks: {
      mysql: { status: "ok" },
      redis: { status: "ok" },
      storage: { status: "ok" },
    },
  });
  assert.throws(
    () =>
      validateReadiness({
        status: "ok",
        checks: {
          mysql: { status: "ok" },
          redis: { status: "error" },
          storage: { status: "ok" },
        },
      }),
    /redis/u,
  );
});

test("healthy service sends one success heartbeat", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("health/ready")) {
      return new Response(
        JSON.stringify({
          status: "ok",
          checks: {
            mysql: { status: "ok" },
            redis: { status: "ok" },
            storage: { status: "ok" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("OK", { status: 200 });
  };
  await runHeartbeat(
    {},
    {
      config: {
        pingUrl: new URL("https://hc-ping.com/secret-check"),
        healthUrl: new URL("http://10.99.0.1:18787/health/ready"),
        healthTimeoutSeconds: 1,
        pingTimeoutSeconds: 1,
        pingRetries: 3,
      },
      fetchImpl,
      sleepImpl: async () => {},
      log: () => {},
    },
  );
  assert.deepEqual(calls, [
    "http://10.99.0.1:18787/health/ready",
    "https://hc-ping.com/secret-check",
  ]);
});

test("unhealthy service withholds success heartbeat", async () => {
  const calls = [];
  await assert.rejects(
    runHeartbeat(
      {},
      {
        config: {
          pingUrl: new URL("https://hc-ping.com/secret-check"),
          healthUrl: new URL("http://10.99.0.1:18787/health/ready"),
          healthTimeoutSeconds: 1,
          pingTimeoutSeconds: 1,
          pingRetries: 3,
        },
        fetchImpl: async (url) => {
          calls.push(String(url));
          return new Response(
            JSON.stringify({
              status: "unavailable",
              checks: {
                mysql: { status: "error" },
                redis: { status: "ok" },
                storage: { status: "ok" },
              },
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        },
        sleepImpl: async () => {},
        log: () => {},
      },
    ),
    /readiness HTTP 503/u,
  );
  assert.deepEqual(calls, ["http://10.99.0.1:18787/health/ready"]);
});

test("test alert sends the failure signal without probing local readiness", async () => {
  const calls = [];
  await runHeartbeat(
    { testAlert: true },
    {
      config: {
        pingUrl: new URL("https://hc-ping.com/secret-check"),
        healthUrl: new URL("http://10.99.0.1:18787/health/ready"),
        healthTimeoutSeconds: 1,
        pingTimeoutSeconds: 1,
        pingRetries: 3,
      },
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response("OK", { status: 200 });
      },
      sleepImpl: async () => {},
      log: () => {},
    },
  );
  assert.deepEqual(calls, ["https://hc-ping.com/secret-check/fail"]);
  assert.equal(
    signalUrlFor(new URL("https://hc-ping.com/secret-check"), "failure").href,
    "https://hc-ping.com/secret-check/fail",
  );
});
