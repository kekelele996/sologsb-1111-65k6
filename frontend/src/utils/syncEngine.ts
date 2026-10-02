import type { Table } from 'dexie';
import { openWorkDb, type WorkCoreDB } from './db';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { LithoLog } from '../types/litho-log';
import { gapsWithin, mergeRanges } from './recovery';
import type {
  ChangeEnvelope,
  DepthConflict,
  SyncAck,
  SyncEntityType,
  SyncPacket,
  WorkstationSide,
} from '../types/sync';
import { deterministicConflictId, envelopeFromOutbox, nowIso } from './syncData';

function otherSide(side: WorkstationSide): WorkstationSide {
  return side === 'field' ? 'office' : 'field';
}

function entityTable(workDb: WorkCoreDB, entityType: SyncEntityType): Table<Record<string, unknown>, string> {
  switch (entityType) {
    case 'holes':
      return workDb.holes as unknown as Table<Record<string, unknown>, string>;
    case 'runs':
      return workDb.runs as unknown as Table<Record<string, unknown>, string>;
    case 'boxes':
      return workDb.boxes as unknown as Table<Record<string, unknown>, string>;
    case 'lithos':
      return workDb.lithos as unknown as Table<Record<string, unknown>, string>;
    case 'qcs':
      return workDb.qcs as unknown as Table<Record<string, unknown>, string>;
  }
}

function assertPacket(packet: SyncPacket, expectedFrom: WorkstationSide): void {
  if (!packet || packet.app !== 'gbdrillcore-sync') throw new Error('不是有效的 gbdrillcore 同步包');
  if (packet.from !== expectedFrom) throw new Error(`同步包来自 ${packet.from}，不能导入 ${expectedFrom} 端`);
  if (packet.to !== otherSide(expectedFrom)) throw new Error('同步包收方端别不匹配');
}

async function buildPacketFrom(sourceDb: WorkCoreDB, side: WorkstationSide): Promise<SyncPacket> {
  const items = await sourceDb.outbox.where('status').anyOf('pending', 'failed').toArray();
  items.sort((a: (typeof items)[number], b: (typeof items)[number]) => a.revision - b.revision || a.updatedAt.localeCompare(b.updatedAt));
  return {
    app: 'gbdrillcore-sync',
    from: side,
    to: otherSide(side),
    sentAt: nowIso(),
    changes: items.map(envelopeFromOutbox),
  };
}

export async function buildOutgoingPacket(side: WorkstationSide): Promise<SyncPacket> {
  return buildPacketFrom(openWorkDb(side), side);
}

async function reconcileDepthConflicts(workDb: WorkCoreDB): Promise<DepthConflict[]> {
  const [holes, runs, lithos, existing]: [DrillHole[], DrillRun[], LithoLog[], DepthConflict[]] = await Promise.all([
    workDb.holes.toArray(),
    workDb.runs.toArray(),
    workDb.lithos.toArray(),
    workDb.conflicts.toArray(),
  ]);
  const detectedAt = nowIso();
  const nextConflicts: DepthConflict[] = [];

  holes.forEach((hole) => {
    const holeRuns = runs.filter((r) => r.holeId === hole.id);
    const holeLithos = lithos.filter((l) => l.holeId === hole.id);
    const runRanges = mergeRanges(holeRuns.map((r) => ({ from: Number(r.fromDepth) || 0, to: Number(r.toDepth) || 0 })));

    holeLithos.forEach((log) => {
      gapsWithin(Number(log.fromDepth) || 0, Number(log.toDepth) || 0, holeRuns).forEach((gap) => {
        const reason = '岩性/样品段缺少现场回次';
        nextConflicts.push({
          id: deterministicConflictId(hole.id, gap.from, gap.to, reason),
          holeId: hole.id,
          fromDepth: gap.from,
          toDepth: gap.to,
          reason,
          fieldRef: runRanges.length ? runRanges.map((r) => `${r.from}~${r.to}m`).join('、') : '无回次',
          officeRef: `${log.fromDepth}~${log.toDepth}m${log.sampleNo ? ` · ${String(log.sampleNo)}` : ''}`,
          status: 'pending',
          detectedAt,
          updatedAt: detectedAt,
        });
      });
    });

  });

  const nextById = new Map(nextConflicts.map((conflict) => [conflict.id, conflict]));
  await workDb.transaction('rw', workDb.conflicts, async () => {
    for (const incoming of nextConflicts) {
      const old = existing.find((item) => item.id === incoming.id);
      if (old?.status === 'resolved') {
        await workDb.conflicts.put(old);
      } else {
        await workDb.conflicts.put({ ...incoming, detectedAt: old?.detectedAt ?? incoming.detectedAt });
      }
    }
    for (const old of existing) {
      if (old.status === 'pending' && !nextById.has(old.id)) {
        await workDb.conflicts.put({
          ...old,
          status: 'resolved',
          decision: old.decision ?? 'hold',
          resolutionNote: old.resolutionNote ?? '再次同步对账，该深度段已一致',
          resolvedAt: detectedAt,
          updatedAt: detectedAt,
        });
      }
    }
  });
  return workDb.conflicts.toArray();
}

export interface ApplyResult {
  ack: SyncAck;
  conflicts: DepthConflict[];
}

/**
 * 应用对端同步包。变更逐条处理：一条坏记录只进 errors，不阻断同包其他深度段；
 * 同版本/旧版本直接幂等跳过。
 */
export async function applySyncPacket(packet: SyncPacket, receiverSide: WorkstationSide): Promise<ApplyResult> {
  assertPacket(packet, otherSide(receiverSide));
  const receiverDb = openWorkDb(receiverSide);
  const appliedChangeIds: string[] = [];
  const errors: SyncAck['errors'] = [];
  const time = nowIso();

  await receiverDb.transaction(
    'rw',
    [
      receiverDb.holes,
      receiverDb.runs,
      receiverDb.boxes,
      receiverDb.lithos,
      receiverDb.qcs,
      receiverDb.syncState,
    ],
    async () => {
      for (const change of packet.changes) {
        try {
          if (change.side !== packet.from) throw new Error('变更归属端与同步包不一致');
          const stateId = `${change.entityType}:${change.entityId}`;
          const state = await receiverDb.syncState.get(stateId);
          if (state && state.lastAppliedRevision >= change.revision) {
            appliedChangeIds.push(change.id);
            continue;
          }
          const table = entityTable(receiverDb, change.entityType);
          if (change.operation === 'delete') {
            await table.delete(change.entityId);
          } else {
            const payload = change.payload as Record<string, unknown>;
            if (!payload || payload.id !== change.entityId) throw new Error('负载缺少匹配的实体 ID');
            if (Number(payload.revision ?? 0) !== change.revision) throw new Error('负载版本与变更版本不一致');
            await table.put(payload);
          }
          await receiverDb.syncState.put({
            id: stateId,
            lastAppliedRevision: change.revision,
            lastAppliedAt: packet.sentAt,
          });
          appliedChangeIds.push(change.id);
        } catch (error) {
          errors.push({ changeId: change.id, message: (error as Error).message });
        }
      }
    },
  );

  const conflicts = await reconcileDepthConflicts(receiverDb);
  return {
    ack: {
      app: 'gbdrillcore-sync-ack',
      from: receiverSide,
      to: packet.from,
      acknowledgedAt: time,
      appliedChangeIds,
      errors,
    },
    conflicts,
  };
}

/** 同一浏览器内两端直连送交：成功即把源端 outbox 标 delivered，已交付版本以后不再挂出 */
export async function deliverDirectly(sourceSide: WorkstationSide): Promise<ApplyResult> {
  const sourceDb = openWorkDb(sourceSide);
  const packet = await buildPacketFrom(sourceDb, sourceSide);
  const result = await applySyncPacket(packet, otherSide(sourceSide));
  await reconcileDepthConflicts(sourceDb);
  const time = nowIso();
  if (result.ack.appliedChangeIds.length || result.ack.errors.length) {
    await sourceDb.transaction('rw', sourceDb.outbox, async () => {
      for (const id of result.ack.appliedChangeIds) {
        const item = await sourceDb.outbox.get(id);
        if (item && !result.ack.errors.some((error) => error.changeId === id)) {
          await sourceDb.outbox.put({
            ...item,
            status: 'delivered',
            attempts: item.attempts + 1,
            lastError: result.ack.errors.find((error) => error.changeId === id)?.message,
            deliveredAt: time,
            updatedAt: time,
          });
        }
      }
      for (const error of result.ack.errors) {
        const item = await sourceDb.outbox.get(error.changeId);
        if (item) {
          await sourceDb.outbox.put({
            ...item,
            status: 'failed',
            attempts: item.attempts + 1,
            lastError: error.message,
            nextRetryAt: time,
            updatedAt: time,
          });
        }
      }
    });
  }
  return result;
}

/** 导入对端回执：只把成功对上的挂单标为 delivered，失败项保留待本侧重试 */
export async function importSyncAck(ack: SyncAck, sourceSide: WorkstationSide): Promise<{ delivered: number; failed: number }> {
  if (!ack || ack.app !== 'gbdrillcore-sync-ack') throw new Error('不是有效的同步回执');
  if (ack.to !== sourceSide) throw new Error('回执收方端别不匹配');
  const sourceDb = openWorkDb(sourceSide);
  let delivered = 0;
  let failed = 0;
  const time = nowIso();
  const errorById = new Map(ack.errors.map((error) => [error.changeId, error.message]));

  await sourceDb.transaction('rw', sourceDb.outbox, async () => {
    for (const id of ack.appliedChangeIds) {
      const item = await sourceDb.outbox.get(id);
      if (!item || item.status === 'delivered') continue;
      await sourceDb.outbox.put({
        ...item,
        status: 'delivered',
        attempts: item.attempts + 1,
        lastError: errorById.get(id),
        deliveredAt: ack.acknowledgedAt,
        updatedAt: time,
      });
      delivered += 1;
    }
    for (const error of ack.errors) {
      const item = await sourceDb.outbox.get(error.changeId);
      if (!item || item.status === 'delivered') continue;
      await sourceDb.outbox.put({
        ...item,
        status: 'failed',
        attempts: item.attempts + 1,
        lastError: error.message,
        nextRetryAt: time,
        updatedAt: time,
      });
      failed += 1;
    }
  });
  await reconcileDepthConflicts(sourceDb);
  return { delivered, failed };
}

export function parseSyncPacket(text: string): SyncPacket {
  return JSON.parse(text) as SyncPacket;
}

export function parseSyncAck(text: string): SyncAck {
  return JSON.parse(text) as SyncAck;
}

export async function listConflicts(side: WorkstationSide): Promise<DepthConflict[]> {
  return openWorkDb(side).conflicts.orderBy('fromDepth').toArray();
}

export async function resolveConflict(
  side: WorkstationSide,
  id: string,
  decision: DepthConflict['decision'],
  resolutionNote: string,
): Promise<void> {
  const workDb = openWorkDb(side);
  const current = await workDb.conflicts.get(id);
  if (!current || current.status === 'resolved') return;
  const time = nowIso();
  await workDb.conflicts.put({
    ...current,
    status: 'resolved',
    decision,
    resolutionNote: resolutionNote.trim() || '已人工裁定',
    resolvedAt: time,
    updatedAt: time,
  });
}

export type { ChangeEnvelope };
