import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const manifestPath = "contracts/api-v1.json";
const current = JSON.parse(await readFile(manifestPath, "utf8"));
const baseRef = process.env.CONTRACT_BASE_REF;

if (!baseRef) {
  console.log(
    "CONTRACT_BASE_REF is not set; skipping cross-revision compatibility check.",
  );
  process.exit(0);
}

const verifyRef = spawnSync(
  "git",
  ["rev-parse", "--verify", `${baseRef}^{commit}`],
  {
    encoding: "utf8",
  },
);
if (verifyRef.status !== 0) {
  throw new Error(
    `Unable to resolve contract base ref ${baseRef}: ${verifyRef.stderr.trim()}`,
  );
}

const baselineResult = spawnSync(
  "git",
  ["show", `${baseRef}:${manifestPath}`],
  {
    encoding: "utf8",
  },
);
if (baselineResult.status !== 0) {
  console.log(
    `No ${manifestPath} exists on ${baseRef}; accepting this PR as the v1 baseline bootstrap.`,
  );
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
