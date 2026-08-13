import { readFile } from "node:fs/promises";

const contracts = await import("../packages/api-contracts/dist/index.js");
const fixtures = JSON.parse(
  await readFile(
    new URL("../contracts/api-v1-fixtures.json", import.meta.url),
    "utf8",
  ),
);

if (
  contracts.API_VERSION !== "v1" ||
  contracts.API_VERSION_PREFIX !== "/api/v1"
) {
  throw new Error("The exported API version constants no longer describe v1.");
}

for (const [schemaName, fixture] of Object.entries(fixtures)) {
  const schema = contracts[schemaName];
  if (!schema || typeof schema.safeParse !== "function") {
    throw new Error(
      `Contract fixture references missing schema ${schemaName}.`,
    );
  }
  const result = schema.safeParse(fixture);
  if (!result.success) {
    throw new Error(
      `Existing v1 fixture no longer parses with ${schemaName}: ${result.error.message}`,
    );
  }
}

console.log(
  `Validated ${Object.keys(fixtures).length} v1 compatibility fixtures.`,
);
