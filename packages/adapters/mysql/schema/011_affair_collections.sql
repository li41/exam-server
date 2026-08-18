CREATE TABLE IF NOT EXISTS affair_collections (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  affair_id CHAR(36) NOT NULL,
  name VARCHAR(200) NOT NULL,
  type ENUM('form', 'excel', 'receipt') NOT NULL,
  target ENUM('school', 'city') NOT NULL DEFAULT 'school',
  sort_order INT NOT NULL DEFAULT 0,
  status ENUM('enabled', 'disabled') NOT NULL DEFAULT 'enabled',
  settings JSON NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_affair_collection_tenant_id (tenant_id, id),
  KEY idx_affair_collections_tenant_affair_sort (
    tenant_id, affair_id, sort_order, id
  ),
  KEY idx_affair_collections_tenant_type_target (
    tenant_id, affair_id, type, target
  ),
  CONSTRAINT fk_affair_collection_affair_tenant
    FOREIGN KEY (tenant_id, affair_id)
    REFERENCES affairs (tenant_id, id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS affair_excel_fields (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NULL,
  data_type ENUM('text', 'number', 'date', 'time', 'select') NOT NULL DEFAULT 'text',
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  validation JSON NULL,
  select_options JSON NULL,
  sort_order INT NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_affair_excel_field_tenant_id (tenant_id, id),
  UNIQUE KEY uq_affair_excel_field_tenant_name (tenant_id, name),
  KEY idx_affair_excel_fields_tenant_sort (tenant_id, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS affair_excel_field_bindings (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  collection_id CHAR(36) NOT NULL,
  field_id CHAR(36) NOT NULL,
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_affair_binding_collection_field (
    tenant_id, collection_id, field_id
  ),
  KEY idx_affair_bindings_tenant_collection_sort (
    tenant_id, collection_id, sort_order, id
  ),
  KEY idx_affair_bindings_tenant_field (tenant_id, field_id),
  CONSTRAINT fk_affair_binding_collection_tenant
    FOREIGN KEY (tenant_id, collection_id)
    REFERENCES affair_collections (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_affair_binding_field_tenant
    FOREIGN KEY (tenant_id, field_id)
    REFERENCES affair_excel_fields (tenant_id, id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS affair_excel_ref_data (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  collection_id CHAR(36) NOT NULL,
  row_data JSON NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_affair_excel_ref_tenant_collection_sort (
    tenant_id, collection_id, sort_order, id
  ),
  CONSTRAINT fk_affair_excel_ref_collection_tenant
    FOREIGN KEY (tenant_id, collection_id)
    REFERENCES affair_collections (tenant_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS affair_form_ref_data (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  collection_id CHAR(36) NOT NULL,
  row_data JSON NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_affair_form_ref_tenant_collection_sort (
    tenant_id, collection_id, sort_order, id
  ),
  CONSTRAINT fk_affair_form_ref_collection_tenant
    FOREIGN KEY (tenant_id, collection_id)
    REFERENCES affair_collections (tenant_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
