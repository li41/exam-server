CREATE TABLE IF NOT EXISTS files (
  file_id CHAR(36) NOT NULL,
  owner_id CHAR(36) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  checksum CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (file_id),
  CONSTRAINT chk_files_status CHECK (status IN ('pending', 'ready', 'deleted')),
  INDEX idx_files_tenant_status (tenant_id, status, created_at),
  INDEX idx_files_owner (owner_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
