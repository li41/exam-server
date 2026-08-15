CREATE TABLE IF NOT EXISTS question_categories (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  parent_id CHAR(36) NULL,
  name VARCHAR(100) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  INDEX idx_question_categories_tenant_parent (tenant_id, parent_id, deleted_at, sort_order, name),
  CONSTRAINT fk_question_categories_parent
    FOREIGN KEY (parent_id) REFERENCES question_categories(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS questions (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  code VARCHAR(50) NOT NULL,
  category_id CHAR(36) NULL,
  created_by CHAR(36) NOT NULL,
  type VARCHAR(30) NOT NULL,
  difficulty TINYINT UNSIGNED NOT NULL DEFAULT 3,
  stem TEXT NOT NULL,
  options JSON NULL,
  answer JSON NOT NULL,
  explanation TEXT NULL,
  ai_rubric JSON NULL,
  points DECIMAL(5,1) NOT NULL DEFAULT 1.0,
  tags JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'enabled',
  usage_count INT UNSIGNED NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  deleted_at DATETIME(3) NULL,
  active_code VARCHAR(50)
    GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN code ELSE NULL END) STORED,
  PRIMARY KEY (id),
  UNIQUE INDEX uk_questions_tenant_active_code (tenant_id, active_code),
  INDEX idx_questions_tenant_updated (tenant_id, deleted_at, updated_at, id),
  INDEX idx_questions_tenant_type (tenant_id, type, deleted_at),
  INDEX idx_questions_tenant_category (tenant_id, category_id, deleted_at),
  INDEX idx_questions_tenant_creator (tenant_id, created_by, deleted_at),
  CONSTRAINT chk_questions_difficulty CHECK (difficulty BETWEEN 1 AND 5),
  CONSTRAINT chk_questions_status CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT fk_questions_category
    FOREIGN KEY (category_id) REFERENCES question_categories(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS question_files (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  question_id CHAR(36) NOT NULL,
  file_id CHAR(36) NOT NULL,
  role VARCHAR(16) NOT NULL,
  option_id VARCHAR(100) NULL,
  position INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uk_question_files_slot (question_id, role, option_id, position),
  INDEX idx_question_files_file (tenant_id, file_id, question_id),
  CONSTRAINT chk_question_files_role
    CHECK (role IN ('stem', 'option', 'explanation', 'attachment')),
  CONSTRAINT fk_question_files_question
    FOREIGN KEY (question_id) REFERENCES questions(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_question_files_file
    FOREIGN KEY (file_id) REFERENCES files(file_id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
