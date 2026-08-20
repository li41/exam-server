import { ConflictError } from "@server-foundation/domain";
import type {
  BlobStorage,
  DownloadSource,
  FileAccessScope,
  QuestionBankRepository,
  QuestionStructureRepository,
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
    private readonly structures?: QuestionStructureRepository,
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
    const questionScope = {
      tenantId: scope.tenantId,
      actorUserId: scope.userId,
      // 🔴 這裡**故意**傳 `null`（＝不收窄），⛔ 不要改成
      //    `visibleQuestionOwnerIdFor(...)`：這一條問的是「還有題目在引用這個檔案嗎」。
      //    收窄的話，「只看自己」的使用者會得到 `false`
      //    ⇒ 刪掉別人題目正在用的檔案，把別人的題目弄壞。
      //    ⇒ 收窄可見範圍是為了少看到東西，不是為了多刪得掉東西。
      //    判準與 port 的 `isFileReferenced` 註解同一條。
      visibleQuestionOwnerId: null,
    };
    if (await this.questions.isFileReferenced(fileId, questionScope)) {
      throw new ConflictError(
        `File ${fileId} is still referenced by an active question. ` +
          `Query /api/v1/questions?fileId=${encodeURIComponent(fileId)} to see affected questions, ` +
          "then remove those media references before deleting the file.",
      );
    }
    if (await this.structures?.isFileReferenced(fileId, questionScope)) {
      throw new ConflictError(
        `File ${fileId} is still referenced as an active question cluster stem. ` +
          "Remove the cluster stemFileId reference before deleting the file.",
      );
    }
    await this.inner.delete(fileId, scope);
  }
}
