import type { FileMetadata } from "@server-foundation/api-contracts";

export interface FileMetadataStore {
  createPending(metadata: FileMetadata): Promise<void>;
  get(fileId: string): Promise<FileMetadata | null>;
  markReady(fileId: string): Promise<void>;
  markDeleted(fileId: string): Promise<void>;
}
