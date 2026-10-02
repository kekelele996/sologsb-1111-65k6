import Dexie, { type Table } from 'dexie';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { LithoLog } from '../types/litho-log';
import type { QualityConclusion } from '../types/quality-control';
import type { DepthConflict, OutboxItem, WorkstationSide } from '../types/sync';
import { getActiveSide } from './workstationSide';

/** 当前端别在模块加载时确定；切换端别后刷新页面以更换 IndexedDB */
export const activeSide: WorkstationSide = getActiveSide();

export const WORK_DB_SCHEMA_VERSION = 3;
const LEGACY_DB_NAME = 'gbdrillcore-db';

export function workDbName(side: WorkstationSide): string {
  return side === 'field' ? 'gbdrillcore-field-db' : 'gbdrillcore-office-db';
}

export type MetaRow = { key: string; value: string };

export class WorkCoreDB extends Dexie {
  holes!: Table<DrillHole, string>;
  runs!: Table<DrillRun, string>;
  boxes!: Table<CoreBox, string>;
  lithos!: Table<LithoLog, string>;
  qcs!: Table<QualityConclusion, string>;
  outbox!: Table<OutboxItem, string>;
  conflicts!: Table<DepthConflict, string>;
  syncState!: Table<import('../types/sync').SyncState, string>;
  meta!: Table<MetaRow, string>;

  constructor(side: WorkstationSide) {
    super(workDbName(side));
    this.version(1).stores({
      holes: 'id, holeNo, rigNo, shift, startDate, ownerSide, revision',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift, ownerSide, revision',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt, ownerSide, revision',
      lithos: 'id, holeId, fromDepth, toDepth, lithology, [holeId+fromDepth], ownerSide, revision',
      qcs: 'id, holeId, fromDepth, toDepth, conclusion, ownerSide, revision',
      outbox: 'id, side, entityType, entityId, status, revision, updatedAt',
      conflicts: 'id, holeId, fromDepth, toDepth, status, updatedAt',
      syncState: 'id, lastAppliedRevision',
      meta: 'key',
    });
  }
}

/**
 * 升级前的混合库。保留原 v1/v2 schema，只用于首次打开时把库里已有数据按归属迁走；
 * 新业务一律读写端别库，避免现场和编录室再互相覆盖。
 */
class LegacyDrillCoreDB extends Dexie {
  [tableName: string]: Table<Record<string, unknown>, string> | unknown;

  holes!: Table<Record<string, unknown>, string>;
  runs!: Table<Record<string, unknown>, string>;
  boxes!: Table<Record<string, unknown>, string>;
  lithos!: Table<Record<string, unknown>, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super(LEGACY_DB_NAME);
    this.version(1).stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, lithology',
      meta: 'key',
    });
    this.version(2)
      .stores({
        holes: 'id, holeNo, rigNo, shift, startDate',
        runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
        boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
        lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('lithos')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.rqd !== 'number') row.rqd = 0;
          });
      });
  }
}

export const legacyDb = new LegacyDrillCoreDB();
const workDbCache = new Map<WorkstationSide, WorkCoreDB>();

export function openWorkDb(side: WorkstationSide): WorkCoreDB {
  const cached = workDbCache.get(side);
  if (cached) return cached;
  const next = new WorkCoreDB(side);
  workDbCache.set(side, next);
  return next;
}

/** 当前端别库 */
export const db = openWorkDb(activeSide);

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
