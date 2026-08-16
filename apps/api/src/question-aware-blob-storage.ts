import { ConflictError } from "@server-foundation/domain";
import type {
  BlobStorage,
  DownloadSource,
  FileAccessScope,
  QuestionBankRepository,
  UploadInput,
} from "@server-foundation/domain";
import type {
  FileMetadata,
  UploadProgress,
  UploadSession,
} from "@server-foundation/api-contracts";

export class QuestionAwareBlobStorage implements BlobStorage {
  constructor(
    private readonly inner: BlobStorage,
    private readonly questions: QuestionBankRepository,
  ) {}

  initiateUpload(input: UploadInput): Promise<UploadSession> {
    return this.inner.initiateUpload(input);
  }

  writeUpload(
    sessionId: string,
    body: ReadableStream<Uint8Array>,
    scope: FileAccessScope,
  ): Promise<UploadProgress> {
    return this.inner.writeUpload(sessionId, body, scope);
  }

  completeUpload(
    sessionId: string,
    scope: FileAccessScope,
  ): Promise<FileMetadata> {
    return this.inner.completeUpload(sessionId, scope);
  }

  cancelUpload(sessionId: string, scope: FileAccessScope): Promise<void> {
    return this.inner.cancelUpload(sessionId, scope);
  }

  getDownload(fileId: string, scope: FileAccessScope): Promise<DownloadSource> {
    return this.inner.getDownload(fileId, scope);
  }

  async delete(fileId: string, scope: FileAccessScope): Promise<void> {
    if (
      await this.questions.isFileReferenced(fileId, {
        tenantId: scope.tenantId,
        actorUserId: scope.userId,
      })
    ) {
      throw new ConflictError(
        `File ${fileId} is still referenced by an active question. ` +
          `Query /api/v1/questions?fileId=${encodeURIComponent(fileId)} to see affected questions, ` +
          "then remove those media references before deleting the file.",
      );
    }
    await this.inner.delete(fileId, scope);
  }
}
