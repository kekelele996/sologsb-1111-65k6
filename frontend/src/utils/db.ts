import Dexie, { type Table } from 'dexie';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { LithoLog } from '../types/litho-log';
import type { QcRecord } from '../types/qc';
import type { OutboxItem } from './syncEngine';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbdrillcore-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

class DrillCoreDB extends Dexie {
  holes!: Table<DrillHole, string>;
  runs!: Table<DrillRun, string>;
  boxes!: Table<CoreBox, string>;
  lithos!: Table<LithoLog, string>;
  /** 质检结论（编录室端持有） */
  qc!: Table<QcRecord, string>;
  // —— 对端只读副本：同步到达后写入，归属端不在此编辑 ——
  /** 编录室端看到的现场端回次副本 */
  runsReplica!: Table<DrillRun, string>;
  /** 编录室端看到的现场端岩芯箱副本 */
  boxesReplica!: Table<CoreBox, string>;
  /** 现场端看到的编录室端岩性区间副本 */
  lithosReplica!: Table<LithoLog, string>;
  /** 现场端看到的编录室端质检结论副本 */
  qcReplica!: Table<QcRecord, string>;
  /** 本侧发件箱：送交失败留本机，按本侧重试，已对上的不重复挂 */
  outbox!: Table<OutboxItem, string>;
  /** 对账不一致与裁定结论（按稳定主键持久化） */
  reconcile!: Table<import('./reconcile').Mismatch, string>;
  /** 同步状态 key-value（上次同步时间等） */
  syncMeta!: Table<{ key: string; value: string }, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, lithology',
      meta: 'key',
    });

    // v2：岩性表增加 (holeId+fromDepth) 复合索引，按深度区间查询更快；并回填历史 rqd 缺省值。
    // 升级前请在顶栏「导出备份」导出 JSON。
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
          .modify((row: LithoLog) => {
            if (typeof row.rqd !== 'number') {
              row.rqd = 0;
            }
          });
      });

    // v3：两端各持一份。新增质检结论表、对端只读副本表、本侧发件箱与同步状态表。
    // 已有主表数据不动；首次打开时由 enableSides() 按归属复制到对端副本。
    this.version(3).stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
      qc: 'id, holeId, fromDepth, toDepth, item, conclusion, inspectedAt',
      runsReplica: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxesReplica: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithosReplica: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
      qcReplica: 'id, holeId, fromDepth, toDepth, item, conclusion, inspectedAt',
      outbox: 'key, side, entity, status, createdAt',
      reconcile: 'id, holeId, type, status',
      syncMeta: 'key',
      meta: 'key',
    });
  }
}

export const db = new DrillCoreDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
