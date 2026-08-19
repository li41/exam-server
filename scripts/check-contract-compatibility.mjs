import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  formatBaseResolution,
  resolveGitBaseRef,
} from "./resolve-git-base-ref.mjs";
import { declareSkip } from "./verify-skip.mjs";

const manifestPath = "contracts/api-v1.json";
const current = JSON.parse(await readFile(manifestPath, "utf8"));
const baseResolution = resolveGitBaseRef({
  envName: "CONTRACT_BASE_REF",
  envValue: process.env.CONTRACT_BASE_REF,
});

if (!baseResolution.resolved) {
  declareSkip({
    gate: "API v1 cross-revision contract compatibility",
    missing: `CONTRACT_BASE_REF unset and local base resolution failed: ${baseResolution.reason}`,
    impact: `whether ${manifestPath} stayed backward compatible with the base revision`,
  });
  process.exit(0);
}

console.log(formatBaseResolution("CONTRACT_BASE_REF", baseResolution));
const baseRef = baseResolution.commit;
const baselineResult = spawnSync(
  "git",
  ["show", `${baseRef}:${manifestPath}`],
  {
    encoding: "utf8",
  },
);
if (baselineResult.status !== 0) {
  // ⚠️ 第二條靜默路徑：base 上沒有 manifest 就「接受為 v1 baseline」。
  //    這同樣是**沒有做比對**，所以一定寫進 skip ledger，不冒充 PASS。
  declareSkip({
    gate: "API v1 cross-revision contract compatibility",
    missing: `${manifestPath} on ${baseRef} (accepted as v1 baseline bootstrap)`,
    impact:
      "any backward-compatibility comparison at all — there was nothing to compare against",
  });
  process.exit(0);
}
const baseline = JSON.parse(baselineResult.stdout);
const problems = [];

if (baseline.version !== current.version) {
  problems.push(
    `version changed from ${baseline.version} to ${current.version}`,
  );
}
if (baseline.prefix !== current.prefix) {
  problems.push(
    `versioned prefix changed from ${baseline.prefix} to ${current.prefix}`,
  );
}

const currentEndpoints = new Map(
  current.endpoints.map((endpoint) => [
    `${endpoint.method} ${endpoint.path}`,
    endpoint,
  ]),
);
for (const endpoint of baseline.endpoints) {
  const key = `${endpoint.method} ${endpoint.path}`;
  const next = currentEndpoints.get(key);
  if (!next) {
    problems.push(`endpoint removed: ${key}`);
    continue;
  }
  if (next.authenticated !== endpoint.authenticated) {
    problems.push(`authentication contract changed: ${key}`);
  }
  if (next.idempotent !== endpoint.idempotent) {
    problems.push(`idempotency contract changed: ${key}`);
  }
}

for (const [name, values] of Object.entries(baseline.closedEnums)) {
  const next = current.closedEnums[name];
  if (!next || JSON.stringify(values) !== JSON.stringify(next)) {
    problems.push(`closed enum changed: ${name}`);
  }
}

const compareSchemaGroup = (groupName, direction) => {
  const beforeGroup = baseline[groupName];
  const nextGroup = current[groupName];
  for (const [schemaName, beforeFields] of Object.entries(beforeGroup)) {
    const nextFields = nextGroup[schemaName];
    if (!nextFields) {
      problems.push(`${direction} schema removed: ${schemaName}`);
      continue;
    }
    for (const [fieldName, before] of Object.entries(beforeFields)) {
      const next = nextFields[fieldName];
      if (!next) {
        problems.push(`${direction} field removed: ${schemaName}.${fieldName}`);
        continue;
      }
      if (next.type !== before.type) {
        problems.push(
          `${direction} field type changed: ${schemaName}.${fieldName}`,
        );
      }
      if (direction === "response" && before.required && !next.required) {
        problems.push(
          `response field became optional: ${schemaName}.${fieldName}`,
        );
      }
      if (direction === "request" && !before.required && next.required) {
        problems.push(
          `request field became required: ${schemaName}.${fieldName}`,
        );
      }
    }
    if (direction === "request") {
      for (const [fieldName, next] of Object.entries(nextFields)) {
        if (!beforeFields[fieldName] && next.required) {
          problems.push(
            `new required request field: ${schemaName}.${fieldName}`,
          );
        }
      }
    }
  }
};

compareSchemaGroup("requestSchemas", "request");
compareSchemaGroup("responseSchemas", "response");

if (problems.length > 0) {
  console.error("Breaking v1 API contract changes detected:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`No breaking v1 contract changes detected against ${baseRef}.`);
