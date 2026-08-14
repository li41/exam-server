import assert from "node:assert/strict";
import test from "node:test";
import { createUser, parseCreateUserArgs } from "./create-user.mjs";

test("parses and normalizes create-user arguments", () => {
  assert.deepEqual(
    parseCreateUserArgs([
      "--email",
      " Admin@Example.com ",
      "--tenant",
      "550e8400-e29b-41d4-a716-446655440000",
      "--roles",
      "owner, member",
    ]),
    {
      email: "admin@example.com",
      tenantId: "550e8400-e29b-41d4-a716-446655440000",
      roles: ["owner", "member"],
    },
  );
});

test("requires tenant and roles and rejects unknown password arguments", () => {
  assert.throws(
    () => parseCreateUserArgs(["--email", "user@example.com"]),
    /usage:/,
  );
  assert.throws(
    () =>
      parseCreateUserArgs([
        "--email",
        "user@example.com",
        "--tenant",
        "550e8400-e29b-41d4-a716-446655440000",
        "--roles",
        "member",
        "--password",
        "secret",
      ]),
    /Unknown argument: --password/,
  );
});

test("rejects duplicate role names", () => {
  assert.throws(
    () =>
      parseCreateUserArgs([
        "--email",
        "user@example.com",
        "--tenant",
        "550e8400-e29b-41d4-a716-446655440000",
        "--roles",
        "member,member",
      ]),
    /must not contain duplicate role names/,
  );
});

test("fails before hashing or inserting when email already exists", async () => {
  let hashCalled = false;
  let createCalled = false;
  const users = {
    async findByEmail() {
      return { userId: "existing" };
    },
    async create() {
      createCalled = true;
      throw new Error("should not create");
    },
  };
  const passwordHasher = {
    async hash() {
      hashCalled = true;
      return "hash";
    },
  };

  await assert.rejects(
    createUser({
      email: "existing@example.com",
      tenantId: "550e8400-e29b-41d4-a716-446655440000",
      roles: ["member"],
      users,
      passwordHasher,
    }),
    /already exists/,
  );
  assert.equal(hashCalled, false);
  assert.equal(createCalled, false);
});

test("hashes generated password and creates exactly one user", async () => {
  const calls = [];
  const users = {
    async findByEmail(email) {
      calls.push(["find", email]);
      return null;
    },
    async create(user) {
      calls.push(["create", user]);
      return { ...user, disabledAt: null };
    },
  };
  const passwordHasher = {
    async hash(password) {
      calls.push(["hash", password]);
      return `hash:${password}`;
    },
  };

  const result = await createUser({
    email: "user@example.com",
    tenantId: "550e8400-e29b-41d4-a716-446655440000",
    roles: ["member"],
    users,
    passwordHasher,
    passwordFactory: () => "generated-secret",
    userIdFactory: () => "550e8400-e29b-41d4-a716-446655440001",
  });

  assert.equal(result.password, "generated-secret");
  assert.equal(result.user.passwordHash, "hash:generated-secret");
  assert.deepEqual(calls, [
    ["find", "user@example.com"],
    ["hash", "generated-secret"],
    [
      "create",
      {
        userId: "550e8400-e29b-41d4-a716-446655440001",
        email: "user@example.com",
        tenantId: "550e8400-e29b-41d4-a716-446655440000",
        roles: ["member"],
        passwordHash: "hash:generated-secret",
      },
    ],
  ]);
});
