import { Table } from 'dexie';
import { db } from './db';
import type { Side } from '../stores/sideStore';
import type { EntityName } from './ownership-types';

export type { EntityName } from './ownership-types';

export const SIDE_LABEL: Record<Side, string> = {
  field: '现场端（钻机班组）',
  catalog: '编录室端（地质编录员）',
};

export const SIDE_SHORT: Record<Side, string> = {
  field: '现场端',
  catalog: '编录室端',
};

/**
 * 各实体归属：
 * - field   现场端（钻机班组）持有：回次 runs、岩芯箱 boxes
 * - catalog 编录室端（地质编录员）持有：岩性区间 lithos、质检结论 qc
 * - shared  双方共享参考：钻孔台帐 holes
 */
export const OWNER: Record<EntityName, Side | 'shared'> = {
  holes: 'shared',
  runs: 'field',
  boxes: 'field',
  lithos: 'catalog',
  qc: 'catalog',
};

/** 实体的主表（归属方可写的那份） */
export function masterTable(entity: EntityName): Table<any, string> {
  switch (entity) {
    case 'holes':
      return db.holes;
    case 'runs':
      return db.runs;
    case 'boxes':
      return db.boxes;
    case 'lithos':
      return db.lithos;
    case 'qc':
      return db.qc;
  }
}

/** 实体在非归属方的只读副本表（同步到达后写入） */
export function replicaTable(entity: EntityName): Table<any, string> {
  switch (entity) {
    case 'runs':
      return db.runsReplica;
    case 'boxes':
      return db.boxesReplica;
    case 'lithos':
      return db.lithosReplica;
    case 'qc':
      return db.qcReplica;
    case 'holes':
      return db.holes; // 共享参考，双方共用同一份
  }
}

/** 当前侧读取某实体应使用的表：归属方读主表，非归属方读同步副本，共享读共享表 */
export function readTable(side: Side, entity: EntityName): Table<any, string> {
  const owner = OWNER[entity];
  if (owner === 'shared') return db.holes;
  return owner === side ? masterTable(entity) : replicaTable(entity);
}

/** 当前侧写入某实体应使用的表（仅归属方可写；共享参考双方可写），越权抛错 */
export function writeTable(side: Side, entity: EntityName): Table<any, string> {
  const owner = OWNER[entity];
  if (owner === 'shared') return db.holes;
  if (owner !== side) {
    throw new Error(`「${SIDE_LABEL[side]}」无权编辑 ${entity}：该数据归「${SIDE_LABEL[owner]}」所有，改动只会落在归属方`);
  }
  return masterTable(entity);
}

/** 当前侧是否拥有某实体的编辑权 */
export function canEdit(side: Side, entity: EntityName): boolean {
  const owner = OWNER[entity];
  return owner === 'shared' || owner === side;
}

/** 某实体归属方的对端标签（用于只读副本提示） */
export function ownerLabel(entity: EntityName): string {
  const owner = OWNER[entity];
  return owner === 'shared' ? '双方共享' : SIDE_LABEL[owner];
}

const OWNERSHIP_FLAG = 'ownershipEnabled';

/**
 * 首次打开按归属迁移：把库里已有的主表数据复制一份到对端只读副本，
 * 让两端启用后都能看到对方的数据；之后改动只走 outbox 同步，不再全量覆盖。
 * 已迁移过（meta 有标记）则跳过。
 */
export async function enableSides(): Promise<void> {
  const flag = await db.meta.get(OWNERSHIP_FLAG);
  if (flag) return;

  await db.transaction(
    'rw',
    [db.holes, db.runs, db.boxes, db.lithos, db.qc, db.runsReplica, db.boxesReplica, db.lithosReplica, db.qcReplica, db.meta],
    async () => {
      const [runs, boxes, lithos, qc] = await Promise.all([
        db.runs.toArray(),
        db.boxes.toArray(),
        db.lithos.toArray(),
        db.qc.toArray(),
      ]);
      // 现场端持有的回次/岩芯箱 → 编录室端只读副本
      if (runs.length) await db.runsReplica.bulkPut(runs);
      if (boxes.length) await db.boxesReplica.bulkPut(boxes);
      // 编录室端持有的岩性区间/质检结论 → 现场端只读副本
      if (lithos.length) await db.lithosReplica.bulkPut(lithos);
      if (qc.length) await db.qcReplica.bulkPut(qc);
      await db.meta.put({ key: OWNERSHIP_FLAG, value: new Date().toISOString() });
    },
  );
}
