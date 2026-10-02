/** 端别：现场钻机班组 / 编录室地质编录员 */
export type WorkstationSide = 'field' | 'office';

export const SIDE_LABEL: Record<WorkstationSide, string> = {
  field: '现场端',
  office: '编录室端',
};

/** 归现场端管理的实体；钻孔主档随现场开孔数据同步给编录室 */
export const FIELD_ENTITY_TYPES = ['holes', 'runs', 'boxes'] as const;
/** 归编录室端管理的实体 */
export const OFFICE_ENTITY_TYPES = ['lithos', 'qcs'] as const;

export type SyncEntityType = 'holes' | 'runs' | 'boxes' | 'lithos' | 'qcs';

export const ENTITY_OWNER: Record<SyncEntityType, WorkstationSide> = {
  holes: 'field',
  runs: 'field',
  boxes: 'field',
  lithos: 'office',
  qcs: 'office',
};

export const ENTITY_LABEL: Record<SyncEntityType, string> = {
  holes: '钻孔主档',
  runs: '回次',
  boxes: '岩芯箱',
  lithos: '岩性区间',
  qcs: '质检结论',
};

/** 所有可同步业务记录携带的归属与版本信息 */
export interface SyncFields {
  /** 数据归属端；只有归属端能修改 */
  ownerSide: WorkstationSide;
  /** 归属端内单调递增的版本，用于幂等对账 */
  revision: number;
  /** 归属端最后修改时间 */
  updatedAt: string;
}

export type OutboxStatus = 'pending' | 'failed' | 'delivered';
export type SyncOperation = 'upsert' | 'delete';

/** 本机送交队列：断网或送交失败时保留，收到回执后标记 delivered */
export interface OutboxItem {
  /** 实体 + 实体 ID + 版本，保证同一版本不会重复挂单 */
  id: string;
  side: WorkstationSide;
  entityType: SyncEntityType;
  entityId: string;
  revision: number;
  operation: SyncOperation;
  payload?: unknown;
  status: OutboxStatus;
  attempts: number;
  lastError?: string;
  nextRetryAt?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
}

export type ConflictStatus = 'pending' | 'resolved';
export type ConflictDecision = 'field' | 'office' | 'hold';

/** 跨端按深度对账出的待裁定段；只挂冲突段，不拦截其他数据 */
export interface DepthConflict {
  id: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  reason: string;
  fieldRef?: string;
  officeRef?: string;
  status: ConflictStatus;
  decision?: ConflictDecision;
  resolutionNote?: string;
  detectedAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface SyncState {
  id: string;
  lastAppliedRevision: number;
  lastAppliedAt?: string;
}

export interface ChangeEnvelope {
  id: string;
  side: WorkstationSide;
  entityType: SyncEntityType;
  entityId: string;
  revision: number;
  operation: SyncOperation;
  payload?: unknown;
}

export interface SyncPacket {
  app: 'gbdrillcore-sync';
  from: WorkstationSide;
  to: WorkstationSide;
  sentAt: string;
  changes: ChangeEnvelope[];
}

export interface SyncAck {
  app: 'gbdrillcore-sync-ack';
  from: WorkstationSide;
  to: WorkstationSide;
  acknowledgedAt: string;
  appliedChangeIds: string[];
  errors: Array<{ changeId: string; message: string }>;
}
