CREATE TABLE IF NOT EXISTS items (
  id CHAR(36) NOT NULL,
  title VARCHAR(200) NOT NULL,
  status VARCHAR(16) NOT NULL,
  version INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_items_status CHECK (status IN ('draft', 'ready')),
  INDEX idx_items_visible_updated (deleted_at, updated_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
