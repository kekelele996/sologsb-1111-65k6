import { legacyDb, openWorkDb, type WorkCoreDB } from './db';
import { SEED_BOXES, SEED_HOLES, SEED_LITHOS, SEED_QCS, SEED_RUNS } from './seed';
import type { SyncEntityType, WorkstationSide } from '../types/sync';
import { nowIso, withOwnership } from './syncData';

const MIGRATION_META_KEY = 'workstation-data-ready-v1';

type RawRow = Record<string, unknown>;

interface BaselineSnapshot {
  holes: RawRow[];
  runs: RawRow[];
  boxes: RawRow[];
  lithos: RawRow[];
  qcs: RawRow[];
  source: 'legacy' | 'seed';
}

async function readLegacySnapshot(): Promise<BaselineSnapshot | undefined> {
  const [holes, runs, boxes, lithos] = await Promise.all([
    legacyDb.holes.toArray(),
    legacyDb.runs.toArray(),
    legacyDb.boxes.toArray(),
    legacyDb.lithos.toArray(),
  ]);
  if (!holes.length && !runs.length && !boxes.length && !lithos.length) return undefined;
  return { holes, runs, boxes, lithos, qcs: [], source: 'legacy' };
}

function seedSnapshot(): BaselineSnapshot {
  return {
    holes: SEED_HOLES as unknown as RawRow[],
    runs: SEED_RUNS as unknown as RawRow[],
    boxes: SEED_BOXES as unknown as RawRow[],
    lithos: SEED_LITHOS as unknown as RawRow[],
    qcs: SEED_QCS as unknown as RawRow[],
    source: 'seed',
  };
}

function stampRows(rows: RawRow[], entityType: SyncEntityType, migratedAt: string) {
  return rows.map((row) => {
    const existingRevision = typeof row.revision === 'number' ? row.revision : undefined;
    const stamped = withOwnership(row, entityType, typeof row.updatedAt === 'string' ? row.updatedAt : migratedAt);
    return {
      ...stamped,
      revision: existingRevision ?? 1,
    };
  });
}

async function prepareWorkDb(side: WorkstationSide, snapshot: BaselineSnapshot, migratedAt: string): Promise<void> {
  const workDb = openWorkDb(side);
  const ready = await workDb.meta.get(MIGRATION_META_KEY);
  if (ready) return;

  const holes = stampRows(snapshot.holes, 'holes', migratedAt);
  const runs = stampRows(snapshot.runs, 'runs', migratedAt);
  const boxes = stampRows(snapshot.boxes, 'boxes', migratedAt);
  const lithos = stampRows(snapshot.lithos, 'lithos', migratedAt);
  const qcs = stampRows(snapshot.qcs, 'qcs', migratedAt);

  await workDb.transaction('rw', workDb.holes, workDb.runs, workDb.boxes, workDb.lithos, workDb.qcs, async () => {
    await workDb.holes.bulkPut(holes as never[]);
    await workDb.runs.bulkPut(runs as never[]);
    await workDb.boxes.bulkPut(boxes as never[]);
    await workDb.lithos.bulkPut(lithos as never[]);
    if (qcs.length) await workDb.qcs.bulkPut(qcs as never[]);
  });
  await workDb.meta.put({
    key: MIGRATION_META_KEY,
    value: JSON.stringify({ side, source: snapshot.source, migratedAt }),
  });
}

/**
 * 首次打开端别分离版本时：
 * - 库里已有数据：以旧库为准，按归属复制到两端，复制件作为对端只读基线；
 * - 旧库为空：写入演示基线；
 * - 不生成 outbox，避免首次迁移把已经对上的基线重复送交。
 */
export async function prepareWorkstationData(): Promise<{ source: 'legacy' | 'seed' }> {
  const fieldReady = await openWorkDb('field').meta.get(MIGRATION_META_KEY);
  const officeReady = await openWorkDb('office').meta.get(MIGRATION_META_KEY);
  if (fieldReady && officeReady) return { source: 'legacy' };

  const migratedAt = nowIso();
  const legacySnapshot = await readLegacySnapshot();
  const snapshot = legacySnapshot ?? seedSnapshot();
  await prepareWorkDb('field', snapshot, migratedAt);
  await prepareWorkDb('office', snapshot, migratedAt);
  return { source: snapshot.source };
}
