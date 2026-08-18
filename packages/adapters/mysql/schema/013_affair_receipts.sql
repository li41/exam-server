ALTER TABLE affair_schools
  ADD UNIQUE KEY uq_affair_school_tenant_affair_id (tenant_id, affair_id, id);

CREATE TABLE IF NOT EXISTS affair_receipts (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  affair_id CHAR(36) NOT NULL,
  submitter_type ENUM('school', 'city') NOT NULL,
  school_id CHAR(36) NULL,
  city_id CHAR(36) NULL,
  account_type VARCHAR(5) NOT NULL,
  account VARCHAR(30) NOT NULL,
  name VARCHAR(50) NOT NULL,
  job_title TEXT NOT NULL,
  id_number TEXT NOT NULL,
  id_number_bidx CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resident_cert TEXT NULL,
  tax_id TEXT NULL,
  phone_area TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  phone_ext TEXT NULL,
  mobile TEXT NOT NULL,
  email TEXT NOT NULL,
  addr_city TEXT NOT NULL,
  addr_district TEXT NOT NULL,
  addr_detail TEXT NOT NULL,
  bank_id CHAR(3) NOT NULL,
  bank_subid CHAR(4) NOT NULL,
  bank_account TEXT NOT NULL,
  bankbook_file_id CHAR(36) NOT NULL,
  positions JSON NOT NULL,
  monitor_classes TINYINT UNSIGNED NULL,
  briefing_region VARCHAR(20) NULL,
  transport_type ENUM('rail', 'island', 'none') NULL,
  transport_origin_area VARCHAR(10) NULL,
  transport_origin_station VARCHAR(10) NULL,
  transport_dest_station VARCHAR(10) NULL,
  transport_fee INT UNSIGNED NULL,
  agreed TINYINT(1) NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_affair_receipt_tenant_id (tenant_id, id),
  UNIQUE KEY uq_affair_receipt_account (tenant_id, affair_id, account),
  UNIQUE KEY uq_affair_receipt_bankbook_file (tenant_id, bankbook_file_id),
  KEY idx_affair_receipt_id_number_bidx (tenant_id, affair_id, id_number_bidx),
  KEY idx_affair_receipt_tenant_submitter (tenant_id, affair_id, submitter_type),
  KEY idx_affair_receipt_tenant_school (tenant_id, school_id),
  KEY idx_affair_receipt_tenant_city (tenant_id, city_id),
  CONSTRAINT chk_affair_receipt_owner_xor CHECK (
    (submitter_type = 'school' AND school_id IS NOT NULL AND city_id IS NULL)
    OR
    (submitter_type = 'city' AND city_id IS NOT NULL AND school_id IS NULL)
  ),
  CONSTRAINT fk_affair_receipt_affair_tenant
    FOREIGN KEY (tenant_id, affair_id)
    REFERENCES affairs (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_affair_receipt_school_tenant
    FOREIGN KEY (tenant_id, affair_id, school_id)
    REFERENCES affair_schools (tenant_id, affair_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_affair_receipt_city_tenant
    FOREIGN KEY (tenant_id, city_id)
    REFERENCES affair_cities (tenant_id, id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS affair_receipt_access_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id VARCHAR(191) NOT NULL,
  affair_id CHAR(36) NOT NULL,
  actor_type ENUM('backend', 'school', 'city') NOT NULL,
  actor_user_id VARCHAR(191) NULL,
  actor_account VARCHAR(30) NULL,
  action ENUM('list', 'view', 'print', 'export', 'delete') NOT NULL,
  receipt_id CHAR(36) NULL,
  record_count INT UNSIGNED NOT NULL DEFAULT 1,
  ip VARCHAR(45) NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_affair_receipt_access_tenant_created (tenant_id, created_at),
  KEY idx_affair_receipt_access_affair_created (tenant_id, affair_id, created_at),
  KEY idx_affair_receipt_access_user (actor_user_id, created_at),
  KEY idx_affair_receipt_access_account (actor_account, created_at)
  -- Deliberately no FK to affair_receipts (or affairs): audit evidence must outlive business rows.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
