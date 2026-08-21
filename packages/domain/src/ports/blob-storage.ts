import type {
  FileMetadata,
  InitiateUploadRequest,
  UploadProgress,
  UploadSession,
} from "@server-foundation/api-contracts";

export type UploadInput = {
  ownerId: string;
  tenantId: string;
} & InitiateUploadRequest;

export type FileAccessScope = {
  userId: string;
  tenantId: string;
  roles: string[];
};

export type DownloadSource = {
  stream: ReadableStream<Uint8Array>;
  contentLength: number;
  mimeType: string;
  fileName: string;
};

export interface BlobStorage {
  initiateUpload(input: UploadInput): Promise<UploadSession>;
  writeUpload(
    sessionId: string,
    body: ReadableStream<Uint8Array>,
    scope: FileAccessScope,
  ): Promise<UploadProgress>;
  completeUpload(
    sessionId: string,
    scope: FileAccessScope,
  ): Promise<FileMetadata>;
  cancelUpload(sessionId: string, scope: FileAccessScope): Promise<void>;
  getMetadata(fileId: string, scope: FileAccessScope): Promise<FileMetadata>;
  getDownload(fileId: string, scope: FileAccessScope): Promise<DownloadSource>;
  delete(fileId: string, scope: FileAccessScope): Promise<void>;
}
