CREATE TABLE IF NOT EXISTS examinee_groups (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  parent_id CHAR(36) NULL,
  name VARCHAR(100) NOT NULL,
  proctor_password_ciphertext VARCHAR(1024) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  deleted_at DATETIME(3) NULL,
  active_parent_scope VARCHAR(36)
    GENERATED ALWAYS AS (
      CASE WHEN deleted_at IS NULL THEN COALESCE(parent_id, '') ELSE NULL END
    ) STORED,
  active_name VARCHAR(100)
    GENERATED ALWAYS AS (
      CASE WHEN deleted_at IS NULL THEN name ELSE NULL END
    ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_examinee_group_id_tenant (id, tenant_id),
  UNIQUE KEY uq_examinee_group_active_sibling_name (
    tenant_id, active_parent_scope, active_name
  ),
  KEY idx_examinee_groups_tenant_parent_sort (
    tenant_id, parent_id, sort_order, id
  ),
  CONSTRAINT fk_examinee_group_parent_tenant
    FOREIGN KEY (parent_id, tenant_id)
    REFERENCES examinee_groups (id, tenant_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS examinees (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  group_id CHAR(36) NULL,
  created_by VARCHAR(191) NOT NULL,
  code_ciphertext VARCHAR(1024) NOT NULL,
  code_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identifier VARCHAR(100) NOT NULL,
  name VARCHAR(100) NOT NULL,
  note TEXT NULL,
  status ENUM('enabled', 'disabled') NOT NULL DEFAULT 'enabled',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  deleted_at DATETIME(3) NULL,
  active_identifier VARCHAR(100)
    GENERATED ALWAYS AS (
      CASE WHEN deleted_at IS NULL THEN identifier ELSE NULL END
    ) STORED,
  active_code_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN deleted_at IS NULL THEN code_digest ELSE NULL END
    ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_examinee_active_identifier (tenant_id, active_identifier),
  UNIQUE KEY uq_examinee_active_code_digest (tenant_id, active_code_digest),
  KEY idx_examinees_tenant_group (tenant_id, group_id),
  KEY idx_examinees_tenant_status (tenant_id, status, updated_at, id),
  KEY idx_examinees_tenant_created_by (tenant_id, created_by),
  CONSTRAINT fk_examinee_group
    FOREIGN KEY (group_id) REFERENCES examinee_groups (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
