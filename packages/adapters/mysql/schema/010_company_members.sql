CREATE TABLE IF NOT EXISTS company_members (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  user_id CHAR(36) NOT NULL,
  invited_email VARCHAR(254) NULL,
  is_admin TINYINT(1) NOT NULL DEFAULT 0,
  permissions JSON NULL,
  status TINYINT UNSIGNED NOT NULL DEFAULT 1,
  review_status TINYINT UNSIGNED NOT NULL DEFAULT 1,
  reviewed_by CHAR(36) NULL,
  reviewed_at DATETIME(3) NULL,
  review_note VARCHAR(500) NULL,
  joined_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_company_members_tenant_user (tenant_id, user_id),
  KEY idx_company_members_tenant_status (tenant_id, status, review_status),
  KEY idx_company_members_tenant_invited_email (tenant_id, invited_email),
  CONSTRAINT fk_company_members_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_company_members_reviewer
    FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_company_members_status CHECK (status IN (0, 1)),
  CONSTRAINT chk_company_members_review_status CHECK (review_status IN (0, 1, 2))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
