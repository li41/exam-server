CREATE TABLE IF NOT EXISTS affairs (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  created_by VARCHAR(191) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NULL,
  status ENUM('enabled', 'disabled') NOT NULL DEFAULT 'enabled',
  city_login_start DATETIME(3) NULL,
  city_login_end DATETIME(3) NULL,
  school_login_start DATETIME(3) NULL,
  school_login_end DATETIME(3) NULL,
  fee_city_contact INT UNSIGNED NOT NULL DEFAULT 0,
  fee_school_contact INT UNSIGNED NOT NULL DEFAULT 0,
  fee_teacher_setup INT UNSIGNED NOT NULL DEFAULT 0,
  fee_teacher_monitor_1 INT UNSIGNED NOT NULL DEFAULT 0,
  fee_teacher_monitor_2 INT UNSIGNED NOT NULL DEFAULT 0,
  fee_teacher_monitor_3 INT UNSIGNED NOT NULL DEFAULT 0,
  transport_receipt_school TINYINT(1) NOT NULL DEFAULT 0,
  transport_receipt_city TINYINT(1) NOT NULL DEFAULT 0,
  briefing_regions JSON NULL,
  receipt_year VARCHAR(10) NULL,
  receipt_note VARCHAR(500) NULL,
  receipt_print_school TINYINT(1) NOT NULL DEFAULT 0,
  receipt_print_city TINYINT(1) NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_affairs_tenant_id (tenant_id, id),
  KEY idx_affairs_tenant_status_created (tenant_id, status, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS affair_cities (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  city_code VARCHAR(10) NOT NULL,
  city_name VARCHAR(10) NOT NULL,
  account VARCHAR(20) NOT NULL,
  password VARCHAR(50) NOT NULL,
  contact_name VARCHAR(50) NULL,
  email VARCHAR(255) NULL,
  phone VARCHAR(30) NULL,
  setup_completed TINYINT(1) NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_affair_city_tenant_code (tenant_id, city_code),
  UNIQUE KEY uq_affair_city_tenant_account (tenant_id, account),
  KEY idx_affair_cities_tenant_code (tenant_id, city_code, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS affair_schools (
  id CHAR(36) NOT NULL,
  affair_id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  city VARCHAR(10) NOT NULL,
  school_level TINYINT UNSIGNED NOT NULL,
  school_code VARCHAR(20) NOT NULL,
  school_name VARCHAR(100) NOT NULL,
  test_classes TINYINT UNSIGNED NOT NULL DEFAULT 1,
  test_sessions TINYINT UNSIGNED NOT NULL DEFAULT 1,
  receipt_code VARCHAR(10) NULL,
  briefing_options JSON NULL,
  password VARCHAR(50) NOT NULL,
  contacts JSON NULL,
  setup_completed JSON NULL,
  status ENUM('enabled', 'disabled') NOT NULL DEFAULT 'enabled',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_affair_school_tenant_id (tenant_id, id),
  UNIQUE KEY uq_affair_school_identity (
    tenant_id, affair_id, school_level, school_code
  ),
  KEY idx_affair_schools_tenant_affair (tenant_id, affair_id, city, school_level, school_code),
  CONSTRAINT fk_affair_school_affair_tenant
    FOREIGN KEY (tenant_id, affair_id)
    REFERENCES affairs (tenant_id, id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
