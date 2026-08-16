CREATE TABLE IF NOT EXISTS test_booklets (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  created_by CHAR(36) NOT NULL,
  subject_id VARCHAR(191) NULL,
  category_id CHAR(36) NULL,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'enabled',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  deleted_at DATETIME(3) NULL,
  active_code VARCHAR(50)
    GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN code ELSE NULL END) STORED,
  PRIMARY KEY (id),
  UNIQUE INDEX uk_test_booklets_tenant_active_code (tenant_id, active_code),
  INDEX idx_test_booklets_tenant_updated (tenant_id, deleted_at, updated_at, id),
  INDEX idx_test_booklets_tenant_creator (tenant_id, created_by, deleted_at),
  INDEX idx_test_booklets_tenant_subject (tenant_id, subject_id, deleted_at),
  INDEX idx_test_booklets_tenant_category (tenant_id, category_id, deleted_at),
  CONSTRAINT chk_test_booklets_status CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT fk_test_booklets_category
    FOREIGN KEY (category_id) REFERENCES question_categories(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS test_booklet_items (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  booklet_id CHAR(36) NOT NULL,
  group_id CHAR(36) NOT NULL,
  position INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uk_test_booklet_items_group (booklet_id, group_id),
  UNIQUE INDEX uk_test_booklet_items_position (booklet_id, position),
  INDEX idx_test_booklet_items_group (tenant_id, group_id, booklet_id),
  CONSTRAINT fk_test_booklet_items_booklet
    FOREIGN KEY (booklet_id) REFERENCES test_booklets(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_test_booklet_items_group
    FOREIGN KEY (group_id) REFERENCES question_groups(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
