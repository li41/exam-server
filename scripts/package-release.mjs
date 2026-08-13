import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const rawVersion = process.env.RELEASE_VERSION || `v${packageJson.version}`;
const version = rawVersion.replace(/[^A-Za-z0-9._-]+/g, "-");
const releaseDirectory = join(root, "release");
const archiveName = `server-foundation-${version}.tar.gz`;
const archivePath = join(releaseDirectory, archiveName);
const temporaryArchive = join(tmpdir(), `${archiveName}.${randomUUID()}.tmp`);

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });

const sha256File = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });

await mkdir(releaseDirectory, { recursive: true });
await rm(archivePath, { force: true });
await run(
  "tar",
  [
    "-czf",
    temporaryArchive,
    "--exclude=.git",
    "--exclude=.github",
    "--exclude=node_modules",
    "--exclude=*/node_modules",
    "--exclude=release",
    "--exclude=.env",
    "--exclude=.env.*",
    "--exclude=deploy/env/*.env",
    "--exclude=backups",
    ".",
  ],
  { cwd: root },
);
await rename(temporaryArchive, archivePath);
const digest = await sha256File(archivePath);
await writeFile(
  `${archivePath}.sha256`,
  `${digest}  ${basename(archivePath)}\n`,
);
await writeFile(
  join(releaseDirectory, `server-foundation-${version}.manifest.json`),
  `${JSON.stringify(
    {
      version: rawVersion,
      gitSha: process.env.GITHUB_SHA || null,
      archive: archiveName,
      sha256: digest,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);
console.log(`Created ${archivePath}`);
