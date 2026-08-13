import type { FileMetadata } from "@server-foundation/api-contracts";
import { NotFoundError } from "@server-foundation/domain";
import type { FileMetadataStore } from "@server-foundation/domain";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

type FileRow = RowDataPacket & {
  file_id: string;
  owner_id: string;
  tenant_id: string;
  original_name: string;
  display_name: string;
  mime_type: string;
  size_bytes: number | string;
  checksum: string;
  status: FileMetadata["status"];
  created_at: Date | string;
  deleted_at: Date | string | null;
};

const toIso = (value: Date | string | null): string | null => {
  if (value === null) return null;
  const date =
    value instanceof Date
      ? value
      : new Date(
          /[zZ]|[+-]\d\d:?\d\d$/.test(value)
            ? value.replace(" ", "T")
            : `${value.replace(" ", "T")}Z`,
        );
  if (Number.isNaN(date.getTime()))
    throw new Error("MySQL returned an invalid file date.");
  return date.toISOString();
};

const toMetadata = (row: FileRow): FileMetadata => ({
  fileId: row.file_id,
  ownerId: row.owner_id,
  tenantId: row.tenant_id,
  originalName: row.original_name,
  displayName: row.display_name,
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  checksum: row.checksum,
  status: row.status,
  createdAt: toIso(row.created_at) ?? "",
  deletedAt: toIso(row.deleted_at),
});

const columns =
  "file_id, owner_id, tenant_id, original_name, display_name, mime_type, size_bytes, checksum, status, created_at, deleted_at";

export class MySqlFileMetadataStore implements FileMetadataStore {
  constructor(private readonly pool: Pool) {}

  async createPending(metadata: FileMetadata): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO files
        (file_id, owner_id, tenant_id, original_name, display_name, mime_type, size_bytes, checksum, status, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      [
        metadata.fileId,
        metadata.ownerId,
        metadata.tenantId,
        metadata.originalName,
        metadata.displayName,
        metadata.mimeType,
        metadata.sizeBytes,
        metadata.checksum,
        new Date(metadata.createdAt),
      ],
    );
  }

  async get(fileId: string): Promise<FileMetadata | null> {
    const [rows] = await this.pool.execute<FileRow[]>(
      `SELECT ${columns} FROM files WHERE file_id = ? LIMIT 1`,
      [fileId],
    );
    const row = rows[0];
    return row ? toMetadata(row) : null;
  }

  async markReady(fileId: string): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE files SET status = 'ready' WHERE file_id = ? AND status = 'pending'",
      [fileId],
    );
    if (result.affectedRows === 0) {
      const metadata = await this.get(fileId);
      if (!metadata) throw new NotFoundError("file", fileId);
      if (metadata.status !== "ready") {
        throw new Error(`File ${fileId} cannot transition to ready.`);
      }
    }
  }

  async markDeleted(fileId: string): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE files SET status = 'deleted', deleted_at = ? WHERE file_id = ? AND status <> 'deleted'",
      [new Date(), fileId],
    );
    if (result.affectedRows === 0) {
      const metadata = await this.get(fileId);
      if (!metadata) throw new NotFoundError("file", fileId);
    }
  }
}
