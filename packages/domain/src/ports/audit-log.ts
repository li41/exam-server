export type AuditEventInput = {
  requestId: string;
  tenantId: string;
  actorUserId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  occurredAt?: string;
  metadata?: Readonly<Record<string, unknown>>;
};

export interface AuditLog {
  record(event: AuditEventInput): Promise<void>;
}
