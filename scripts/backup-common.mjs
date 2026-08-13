import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

export const backupManifestVersion = 1;
export const storageBackupDirectories = ["files", "metadata"];

export const pathExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && error.code === "ENOENT") return false;
    throw error;
  }
};

export const assertDirectory = async (path, description) => {
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch (error) {
    if (error instanceof Error && error.code === "ENOENT") {
      throw new Error(`${description} does not exist: ${path}`);
    }
    throw error;
  }
  if (!fileStat.isDirectory()) {
    throw new Error(`${description} is not a directory: ${path}`);
  }
};

const assertOptionValue = (name, value) => {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${name} must not contain a newline.`);
  }
};

export const parseMySqlUrl = (connectionString) => {
  let url;
  try {
    url = new URL(connectionString);
  } catch (error) {
    throw new Error("MYSQL_URL is not a valid URL.", { cause: error });
  }
  if (url.protocol !== "mysql:") {
    throw new Error("MYSQL_URL must use the mysql: scheme.");
  }

  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const result = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
  if (!result.host || !Number.isSafeInteger(result.port) || result.port <= 0) {
    throw new Error("MYSQL_URL must contain a valid host and port.");
  }
  if (!result.database) throw new Error("MYSQL_URL must contain a database.");
  assertOptionValue("MySQL host", result.host);
  assertOptionValue("MySQL user", result.user);
  assertOptionValue("MySQL password", result.password);
  assertOptionValue("MySQL database", result.database);
  return result;
};

export const withMySqlOptionFile = async (connectionString, callback) => {
  const connection = parseMySqlUrl(connectionString);
  const directory = await mkdtemp(join(tmpdir(), "server-foundation-mysql-"));
  const optionFile = join(directory, "client.cnf");
  const quoteOptionValue = (value) =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const lines = [
    "[client]",
    `host=${quoteOptionValue(connection.host)}`,
    `port=${connection.port}`,
    `user=${quoteOptionValue(connection.user)}`,
    `password=${quoteOptionValue(connection.password)}`,
    ...(process.env.MYSQL_SSL_MODE
      ? [`ssl-mode=${quoteOptionValue(process.env.MYSQL_SSL_MODE)}`]
      : []),
    ...(process.env.MYSQL_SSL_CA
      ? [`ssl-ca=${quoteOptionValue(process.env.MYSQL_SSL_CA)}`]
      : []),
  ];
  await writeFile(optionFile, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    return await callback(optionFile, connection);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const runCommand = (command, args, { stdinPath } = {}) =>
  new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      stdio: [stdinPath ? "pipe" : "ignore", "inherit", "inherit"],
    });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectCommand(error);
    };

    child.once("error", (error) => {
      fail(new Error(`Could not execute ${command}.`, { cause: error }));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolveCommand();
      } else {
        rejectCommand(
          new Error(`${command} exited with code ${code ?? "unknown"}.`),
        );
      }
    });
    if (stdinPath) {
      const input = createReadStream(stdinPath);
      input.once("error", (error) => {
        child.kill();
        fail(new Error(`Could not read ${stdinPath}.`, { cause: error }));
      });
      input.pipe(child.stdin);
    }
  });

export const sha256File = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const relativeStoragePath = (root, path) =>
  relative(root, path).split(sep).join("/");

const walkFiles = async (root, current = root) => {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Storage backup does not support symbolic links: ${path}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, path)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Storage backup only supports regular files: ${path}`);
    }
    const fileStat = await stat(path);
    files.push({
      path: relativeStoragePath(root, path),
      sizeBytes: fileStat.size,
      sha256: await sha256File(path),
    });
  }
  return files;
};

export const collectStorageFiles = async (storageRoot) => {
  const files = [];
  for (const directory of storageBackupDirectories) {
    const path = join(storageRoot, directory);
    if (!(await pathExists(path))) continue;
    files.push(
      ...(await walkFiles(storageRoot, path)).map((file) => ({
        ...file,
        path: `${directory}/${file.path.slice(directory.length + 1)}`,
      })),
    );
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

export const assertSafeRelativePath = (path) => {
  const portablePath = path.replaceAll("\\", "/");
  const normalized = normalize(portablePath);
  if (
    !portablePath ||
    portablePath.includes("\0") ||
    isAbsolute(portablePath) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    portablePath.split("/").includes("..")
  ) {
    throw new Error(`Unsafe backup relative path: ${path}`);
  }
  return portablePath;
};

export const resolveBackupPath = (root, portablePath) => {
  const safePath = assertSafeRelativePath(portablePath);
  const rootPath = resolve(root);
  const target = resolve(rootPath, ...safePath.split("/"));
  if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Backup path escapes its root: ${portablePath}`);
  }
  return target;
};

export const assertDisjointPaths = (left, right) => {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  if (
    leftPath === rightPath ||
    leftPath.startsWith(`${rightPath}${sep}`) ||
    rightPath.startsWith(`${leftPath}${sep}`)
  ) {
    throw new Error("Backup root and storage root must be separate paths.");
  }
};

export const copyStorageSnapshot = async (sourceRoot, destinationRoot) => {
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  for (const directory of storageBackupDirectories) {
    const source = join(sourceRoot, directory);
    const destination = join(destinationRoot, directory);
    if (await pathExists(source)) {
      await cp(source, destination, { recursive: true, force: true });
    } else {
      await mkdir(destination, { recursive: true, mode: 0o700 });
    }
  }
};

export const verifyStorageFiles = async (storageRoot, manifestFiles) => {
  const actualFiles = await collectStorageFiles(storageRoot);
  const expected = [...manifestFiles].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (actualFiles.length !== expected.length) {
    throw new Error(
      `Storage file count differs: expected ${expected.length}, got ${actualFiles.length}.`,
    );
  }
  for (const [index, expectedFile] of expected.entries()) {
    const actualFile = actualFiles[index];
    if (
      !actualFile ||
      actualFile.path !== expectedFile.path ||
      actualFile.sizeBytes !== expectedFile.sizeBytes ||
      actualFile.sha256 !== expectedFile.sha256
    ) {
      throw new Error(`Storage checksum mismatch: ${expectedFile.path}.`);
    }
  }
};

export const validateManifest = (manifest) => {
  if (manifest?.version !== backupManifestVersion) {
    throw new Error(
      `Unsupported backup manifest version: ${manifest?.version}.`,
    );
  }
  if (
    typeof manifest.database?.dump !== "string" ||
    !/^[^/\\]+$/.test(manifest.database.dump) ||
    typeof manifest.database?.sha256 !== "string"
  ) {
    throw new Error("Backup manifest has an invalid database entry.");
  }
  if (!Array.isArray(manifest.storage?.files)) {
    throw new Error("Backup manifest has an invalid storage entry.");
  }
  for (const file of manifest.storage.files) {
    if (
      typeof file?.path !== "string" ||
      !Number.isSafeInteger(file?.sizeBytes) ||
      file.sizeBytes < 0 ||
      typeof file?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error("Backup manifest has an invalid storage file entry.");
    }
    assertSafeRelativePath(file.path);
  }
};

export const writeJsonAtomic = async (path, value) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const readJson = async (path) =>
  JSON.parse(await readFile(path, { encoding: "utf8" }));
