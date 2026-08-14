import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Argon2PasswordHasher } from "../packages/auth/dist/index.js";
import {
  createMySqlPool,
  MySqlUserRepository,
} from "../packages/adapters/mysql/dist/index.js";

const usage =
  "usage: node scripts/create-user.mjs --email <email> --tenant <uuid> --roles <a,b>";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const duplicateEmailError = (email) =>
  new Error(`A user with email ${email} already exists.`);

const isDuplicateEntryError = (error) =>
  error !== null &&
  typeof error === "object" &&
  (("code" in error && error.code === "ER_DUP_ENTRY") ||
    ("errno" in error && error.errno === 1062));

export const parseCreateUserArgs = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(usage);
    }
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}.`);
    values.set(key, value);
  }

  const allowed = new Set(["--email", "--tenant", "--roles"]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}. ${usage}`);
  }

  const email = values.get("--email")?.trim().toLowerCase();
  const tenantId = values.get("--tenant")?.trim();
  const rawRoles = values.get("--roles")?.trim();

  if (!email || !tenantId || !rawRoles) throw new Error(usage);
  if (email.length > 254 || !emailPattern.test(email)) {
    throw new Error("--email must be a valid email address.");
  }
  if (!uuidPattern.test(tenantId)) {
    throw new Error("--tenant must be a UUID.");
  }

  const roles = rawRoles
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  if (roles.length === 0 || roles.some((role) => role.length > 100)) {
    throw new Error("--roles must contain one or more comma-separated role names.");
  }
  if (new Set(roles).size !== roles.length) {
    throw new Error("--roles must not contain duplicate role names.");
  }

  return { email, tenantId, roles };
};

export const createUser = async ({
  email,
  tenantId,
  roles,
  users,
  passwordHasher,
  passwordFactory = () => randomBytes(24).toString("base64url"),
  userIdFactory = randomUUID,
}) => {
  if (await users.findByEmail(email)) {
    throw duplicateEmailError(email);
  }

  const password = passwordFactory();
  if (!password) throw new Error("Generated password was empty.");
  const passwordHash = await passwordHasher.hash(password);

  let user;
  try {
    user = await users.create({
      userId: userIdFactory(),
      email,
      tenantId,
      roles,
      passwordHash,
    });
  } catch (error) {
    if (isDuplicateEntryError(error)) throw duplicateEmailError(email);
    throw error;
  }

  return { user, password };
};

export const main = async ({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) => {
  let pool;
  try {
    const input = parseCreateUserArgs(argv);
    const mysqlUrl = env.MYSQL_URL?.trim();
    if (!mysqlUrl) throw new Error("MYSQL_URL is required.");

    pool = createMySqlPool(mysqlUrl);
    const result = await createUser({
      ...input,
      users: new MySqlUserRepository(pool),
      passwordHasher: new Argon2PasswordHasher(),
    });

    stdout.write(`Created user ${result.user.email} (${result.user.userId}).\n`);
    stdout.write(`Generated password: ${result.password}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (pool) await pool.end();
  }
};

const isEntryPoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isEntryPoint) {
  process.exitCode = await main();
}
