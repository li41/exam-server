ALTER TABLE items
  ADD COLUMN tenant_id CHAR(36) NULL AFTER id,
  ADD INDEX idx_items_tenant_visible_updated
    (tenant_id, deleted_at, updated_at, id);

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  roles JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  disabled_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  INDEX idx_users_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
