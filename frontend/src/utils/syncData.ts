import {
  ENTITY_OWNER,
  type ChangeEnvelope,
  type OutboxItem,
  type SyncEntityType,
  type SyncFields,
  type SyncOperation,
  type WorkstationSide,
} from '../types/sync';

export function nowIso(): string {
  return new Date().toISOString();
}

/** 给已有记录补归属信息；首次迁移统一作为 revision=1 基线，不进送交队列 */
export function withOwnership<T extends object>(
  row: T,
  entityType: SyncEntityType,
  updatedAt = nowIso(),
): T & SyncFields {
  const syncFields: SyncFields = {
    ownerSide: ENTITY_OWNER[entityType],
    revision: 1,
    updatedAt,
  };
  return { ...(row as Record<string, unknown>), ...syncFields } as T & SyncFields;
}

export function stampNew<T extends object>(row: T, entityType: SyncEntityType): T & SyncFields {
  return withOwnership(row, entityType);
}

export function stampUpdate<T extends SyncFields>(row: T, patch: Partial<T>): T {
  return {
    ...row,
    ...patch,
    ownerSide: row.ownerSide,
    revision: row.revision + 1,
    updatedAt: nowIso(),
  };
}

export function outboxId(entityType: SyncEntityType, entityId: string, revision: number): string {
  return `outbox-${entityType}-${entityId}-r${revision}`;
}

export function buildOutboxItem(input: {
  side: WorkstationSide;
  entityType: SyncEntityType;
  entityId: string;
  revision: number;
  operation: SyncOperation;
  payload?: unknown;
  status?: OutboxItem['status'];
  createdAt?: string;
}): OutboxItem {
  const time = input.createdAt ?? nowIso();
  return {
    id: outboxId(input.entityType, input.entityId, input.revision),
    side: input.side,
    entityType: input.entityType,
    entityId: input.entityId,
    revision: input.revision,
    operation: input.operation,
    payload: input.payload,
    status: input.status ?? 'pending',
    attempts: 0,
    createdAt: time,
    updatedAt: time,
  };
}

export function envelopeFromOutbox(item: OutboxItem): ChangeEnvelope {
  return {
    id: item.id,
    side: item.side,
    entityType: item.entityType,
    entityId: item.entityId,
    revision: item.revision,
    operation: item.operation,
    payload: item.payload,
  };
}

export function changeId(side: WorkstationSide, entityType: SyncEntityType, entityId: string, revision: number): string {
  return `outbox-${entityType}-${entityId}-r${revision}`;
}

export function deterministicConflictId(holeId: string, fromDepth: number, toDepth: number, reason: string): string {
  const raw = `${holeId}|${fromDepth}|${toDepth}|${reason}`;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `conflict-${(hash >>> 0).toString(36)}`;
}
