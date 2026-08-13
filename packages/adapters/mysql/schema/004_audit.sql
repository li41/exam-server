CREATE TABLE audit_events (
  id CHAR(36) NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  actor_user_id CHAR(36) NOT NULL,
  request_id VARCHAR(64) NOT NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(255) NULL,
  metadata JSON NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_audit_tenant_occurred (tenant_id, occurred_at, id),
  INDEX idx_audit_actor_occurred (actor_user_id, occurred_at, id),
  INDEX idx_audit_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
