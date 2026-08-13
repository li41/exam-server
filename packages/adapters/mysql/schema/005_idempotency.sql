CREATE TABLE IF NOT EXISTS idempotency_records (
  record_key CHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL,
  response_status SMALLINT UNSIGNED NULL,
  response_body MEDIUMTEXT NULL,
  response_content_type VARCHAR(255) NULL,
  expires_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (record_key),
  KEY idx_idempotency_expiry (state, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
