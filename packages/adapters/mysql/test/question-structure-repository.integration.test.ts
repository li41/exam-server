import { ConflictError, DomainError } from "@server-foundation/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMySqlPool,
  MySqlQuestionBankRepository,
  MySqlQuestionStructureRepository,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const questions = new MySqlQuestionBankRepository(pool);
const structures = new MySqlQuestionStructureRepository(pool);
const scope = {
  tenantId: "37000000-0000-4000-8000-000000000001",
  actorUserId: "37000000-0000-4000-8000-000000000002",
};
const otherScope = {
  tenantId: "37000000-0000-4000-8000-000000000099",
  actorUserId: "37000000-0000-4000-8000-000000000098",
};

const questionInput = (code: string) => ({
  code,
  type: "single_choice" as const,
  difficulty: 3,
  stem: `題目 ${code}`,
  options: [
    { id: "a", text: "A" },
    { id: "b", text: "B" },
  ],
  answer: { value: "a" },
  explanation: null,
  aiRubric: null,
  points: 1,
  tags: ["structure-integration"],
  status: "enabled" as const,
  media: [],
});

const clusterInput = (code: string, questionIds: string[] = []) => ({
  code,
  name: `題組 ${code}`,
  stem: `共同素材 ${code}`,
  stemFileId: null,
  description: null,
  status: "enabled" as const,
  questionIds,
});

describe("MySqlQuestionStructureRepository", () => {
  beforeAll(async () => {
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("keeps cluster child relations visible after a question is soft-deleted", async () => {
    const question = await questions.createQuestion(
      questionInput("STRUCT-CL-Q1"),
      scope,
    );
    const cluster = await structures.createCluster(
      clusterInput("STRUCT-CL-001", [question.id]),
      scope,
    );
    expect(cluster.items).toEqual([
      { questionId: question.id, position: 0, available: true },
    ]);

    await questions.softDeleteQuestion(question.id, question.version, scope);
    await expect(structures.getCluster(cluster.id, scope)).resolves.toMatchObject({
      items: [{ questionId: question.id, available: false }],
    });
  });

  it("treats cross-tenant questions and stem files as unavailable", async () => {
    const foreignQuestion = await questions.createQuestion(
      questionInput("STRUCT-FOREIGN-Q"),
      otherScope,
    );
    await expect(
      structures.createCluster(
        clusterInput("STRUCT-CROSS-Q", [foreignQuestion.id]),
        scope,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });

    const foreignFileId = "37000000-0000-4000-8000-000000000050";
    await pool.execute("DELETE FROM files WHERE file_id = ?", [foreignFileId]);
    await pool.execute(
      `INSERT INTO files
        (file_id, owner_id, tenant_id, original_name, display_name, mime_type,
         size_bytes, checksum, status, created_at, deleted_at)
       VALUES (?, ?, ?, 'cluster.png', 'Cluster', 'image/png', 1, ?, 'ready', ?, NULL)`,
      [
        foreignFileId,
        otherScope.actorUserId,
        otherScope.tenantId,
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        new Date(),
      ],
    );

    const crossTenantError = await structures
      .createCluster(
        {
          ...clusterInput("STRUCT-CROSS-FILE"),
          stemFileId: foreignFileId,
        },
        scope,
      )
      .catch((error: unknown) => error);
    expect(crossTenantError).toBeInstanceOf(DomainError);
    expect(crossTenantError).toMatchObject({
      code: "validation_error",
      message: `Question cluster stemFileId "${foreignFileId}" does not exist.`,
    });
  });

  it("supports mixed group items but rejects a standalone question duplicated through a cluster", async () => {
    const clusteredQuestion = await questions.createQuestion(
      questionInput("STRUCT-GR-Q1"),
      scope,
    );
    const standaloneQuestion = await questions.createQuestion(
      questionInput("STRUCT-GR-Q2"),
      scope,
    );
    const cluster = await structures.createCluster(
      clusterInput("STRUCT-GR-CL", [clusteredQuestion.id]),
      scope,
    );

    await expect(
      structures.createGroup(
        {
          code: "STRUCT-GR-CONFLICT",
          name: "衝突區塊",
          description: null,
          subjectId: null,
          flowMode: "normal",
          status: "enabled",
          items: [
            { itemType: "cluster", clusterId: cluster.id },
            { itemType: "question", questionId: clusteredQuestion.id },
          ],
        },
        scope,
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    const group = await structures.createGroup(
      {
        code: "STRUCT-GR-001",
        name: "合法區塊",
        description: null,
        subjectId: null,
        flowMode: "shuffle",
        status: "enabled",
        items: [
          { itemType: "cluster", clusterId: cluster.id },
          { itemType: "question", questionId: standaloneQuestion.id },
        ],
      },
      scope,
    );
    expect(group.items).toEqual([
      {
        itemType: "cluster",
        clusterId: cluster.id,
        position: 0,
        available: true,
      },
      {
        itemType: "question",
        questionId: standaloneQuestion.id,
        position: 1,
        available: true,
      },
    ]);

    await expect(
      structures.softDeleteCluster(cluster.id, cluster.version, scope),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
