CREATE TABLE IF NOT EXISTS question_clusters (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  created_by CHAR(36) NOT NULL,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(200) NOT NULL,
  stem TEXT NOT NULL,
  stem_file_id CHAR(36) NULL,
  description TEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'enabled',
  usage_count INT UNSIGNED NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  deleted_at DATETIME(3) NULL,
  active_code VARCHAR(50)
    GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN code ELSE NULL END) STORED,
  PRIMARY KEY (id),
  UNIQUE INDEX uk_question_clusters_tenant_active_code (tenant_id, active_code),
  INDEX idx_question_clusters_tenant_updated (tenant_id, deleted_at, updated_at, id),
  INDEX idx_question_clusters_tenant_creator (tenant_id, created_by, deleted_at),
  INDEX idx_question_clusters_file (tenant_id, stem_file_id, deleted_at),
  CONSTRAINT chk_question_clusters_status CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT fk_question_clusters_stem_file
    FOREIGN KEY (stem_file_id) REFERENCES files(file_id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS question_cluster_items (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  cluster_id CHAR(36) NOT NULL,
  question_id CHAR(36) NOT NULL,
  position INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uk_question_cluster_items_question (cluster_id, question_id),
  UNIQUE INDEX uk_question_cluster_items_position (cluster_id, position),
  INDEX idx_question_cluster_items_question (tenant_id, question_id, cluster_id),
  CONSTRAINT fk_question_cluster_items_cluster
    FOREIGN KEY (cluster_id) REFERENCES question_clusters(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_question_cluster_items_question
    FOREIGN KEY (question_id) REFERENCES questions(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS question_groups (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  created_by CHAR(36) NOT NULL,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NULL,
  subject_id CHAR(36) NULL,
  flow_mode VARCHAR(16) NOT NULL DEFAULT 'normal',
  status VARCHAR(16) NOT NULL DEFAULT 'enabled',
  usage_count INT UNSIGNED NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  deleted_at DATETIME(3) NULL,
  active_code VARCHAR(50)
    GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN code ELSE NULL END) STORED,
  PRIMARY KEY (id),
  UNIQUE INDEX uk_question_groups_tenant_active_code (tenant_id, active_code),
  INDEX idx_question_groups_tenant_updated (tenant_id, deleted_at, updated_at, id),
  INDEX idx_question_groups_tenant_creator (tenant_id, created_by, deleted_at),
  INDEX idx_question_groups_subject (tenant_id, subject_id, deleted_at),
  CONSTRAINT chk_question_groups_status CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT chk_question_groups_flow_mode CHECK (flow_mode IN ('normal', 'shuffle', 'skip')),
  CONSTRAINT fk_question_groups_subject
    FOREIGN KEY (subject_id) REFERENCES question_categories(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS question_group_items (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  group_id CHAR(36) NOT NULL,
  item_type VARCHAR(16) NOT NULL,
  question_id CHAR(36) NULL,
  cluster_id CHAR(36) NULL,
  position INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uk_question_group_items_position (group_id, position),
  UNIQUE INDEX uk_question_group_items_question (group_id, item_type, question_id),
  UNIQUE INDEX uk_question_group_items_cluster (group_id, item_type, cluster_id),
  INDEX idx_question_group_items_question (tenant_id, question_id, group_id),
  INDEX idx_question_group_items_cluster (tenant_id, cluster_id, group_id),
  CONSTRAINT chk_question_group_items_type CHECK (item_type IN ('question', 'cluster')),
  CONSTRAINT chk_question_group_items_target CHECK (
    (item_type = 'question' AND question_id IS NOT NULL AND cluster_id IS NULL)
    OR
    (item_type = 'cluster' AND cluster_id IS NOT NULL AND question_id IS NULL)
  ),
  CONSTRAINT fk_question_group_items_group
    FOREIGN KEY (group_id) REFERENCES question_groups(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_question_group_items_question
    FOREIGN KEY (question_id) REFERENCES questions(id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_question_group_items_cluster
    FOREIGN KEY (cluster_id) REFERENCES question_clusters(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
