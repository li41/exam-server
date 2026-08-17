ALTER TABLE affair_cities
  ADD UNIQUE KEY uq_affair_city_tenant_id (tenant_id, id);

CREATE TABLE IF NOT EXISTS affair_submissions (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  affair_id CHAR(36) NOT NULL,
  collection_id CHAR(36) NOT NULL,
  submitter_type ENUM('school', 'city') NOT NULL,
  school_id CHAR(36) NULL,
  city_id CHAR(36) NULL,
  account_type VARCHAR(5) NULL,
  status ENUM('draft', 'submitted', 'returned') NOT NULL DEFAULT 'draft',
  return_reason VARCHAR(500) NULL,
  returned_at DATETIME(3) NULL,
  submitted_at DATETIME(3) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_affair_submission_tenant_id (tenant_id, id),
  UNIQUE KEY uq_affair_submission_school_collection (
    tenant_id, school_id, collection_id
  ),
  UNIQUE KEY uq_affair_submission_city_collection (
    tenant_id, city_id, collection_id
  ),
  KEY idx_affair_submissions_tenant_collection_status (
    tenant_id, collection_id, status, updated_at, id
  ),
  KEY idx_affair_submissions_tenant_affair (tenant_id, affair_id, id),
  CONSTRAINT chk_affair_submission_owner CHECK (
    (submitter_type = 'school' AND school_id IS NOT NULL AND city_id IS NULL)
    OR
    (submitter_type = 'city' AND city_id IS NOT NULL AND school_id IS NULL)
  ),
  CONSTRAINT fk_affair_submission_affair_tenant
    FOREIGN KEY (tenant_id, affair_id)
    REFERENCES affairs (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_affair_submission_collection_tenant
    FOREIGN KEY (tenant_id, collection_id)
    REFERENCES affair_collections (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_affair_submission_school_tenant
    FOREIGN KEY (tenant_id, school_id)
    REFERENCES affair_schools (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_affair_submission_city_tenant
    FOREIGN KEY (tenant_id, city_id)
    REFERENCES affair_cities (tenant_id, id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS affair_submission_data (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  submission_id CHAR(36) NOT NULL,
  field_id CHAR(36) NOT NULL,
  value TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_affair_submission_data_field (
    tenant_id, submission_id, field_id
  ),
  KEY idx_affair_submission_data_tenant_field (tenant_id, field_id),
  CONSTRAINT fk_affair_submission_data_submission_tenant
    FOREIGN KEY (tenant_id, submission_id)
    REFERENCES affair_submissions (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_affair_submission_data_field_tenant
    FOREIGN KEY (tenant_id, field_id)
    REFERENCES affair_excel_fields (tenant_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS affair_submission_rows (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  submission_id CHAR(36) NOT NULL,
  row_data JSON NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_affair_submission_rows_tenant_submission_sort (
    tenant_id, submission_id, sort_order, id
  ),
  CONSTRAINT fk_affair_submission_row_submission_tenant
    FOREIGN KEY (tenant_id, submission_id)
    REFERENCES affair_submissions (tenant_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
