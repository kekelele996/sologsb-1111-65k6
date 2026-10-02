import { db } from './db';
import type { Side } from '../stores/sideStore';
import { replicaTable, type EntityName } from './ownership';

export interface OutboxItem {
  /** 主键：`${side}:${entity}:${id}`，同一条记录只保留最新一次待送交状态 */
  key: string;
  /** 产生改动的端 */
  side: Side;
  entity: EntityName;
  op: 'upsert' | 'delete';
  id: string;
  /** upsert 时的记录全文；delete 时为 null */
  payload: unknown;
  createdAt: string;
  /** 已送交次数（失败重试累加） */
  attempts: number;
  status: 'pending' | 'synced' | 'failed';
  lastError?: string;
  syncedAt?: string;
}

export interface SyncResult {
  /** 本次成功送交条数 */
  pushed: number;
  /** 本次失败条数（留在本机待重试） */
  failed: number;
  /** 已对上、跳过未重复挂的条数 */
  skipped: number;
  errors: Array<{ key: string; error: string }>;
}

/**
 * 把一次改动挂到本侧发件箱。
 * 断网/弱网时照旧先落本地，回到驻地再同步；送交失败也留在本机按本侧重试。
 * 同一条记录只保留最新状态，已 synced 的记录若再改会重新置为 pending。
 */
export async function enqueue(
  side: Side,
  entity: EntityName,
  op: 'upsert' | 'delete',
  id: string,
  payload: unknown,
): Promise<void> {
  const key = `${side}:${entity}:${id}`;
  const item: OutboxItem = {
    key,
    side,
    entity,
    op,
    id,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: 'pending',
  };
  await db.outbox.put(item);
}

/** 把一条待送交项应用到对端只读副本（模拟“送交”动作） */
async function applyToReplica(item: OutboxItem, simulateFail: boolean): Promise<void> {
  if (simulateFail) {
    throw new Error('弱网模拟：送交失败（未到达对端，已留在本机待重试）');
  }
  const table = replicaTable(item.entity);
  if (item.op === 'delete') {
    await table.delete(item.id);
  } else {
    await table.put(item.payload as never);
  }
}

/** 同步本侧待送交项到对端；已对上(synced)的不重复挂；失败留本机，不阻塞其他段 */
export async function syncSide(side: Side, opts: { simulateFail?: boolean } = {}): Promise<SyncResult> {
  const all = await db.outbox.where('side').equals(side).toArray();
  const pending = all.filter((it) => it.status === 'pending' || it.status === 'failed');
  // 按产生顺序送交，保证同一条记录的多次改动按序到达
  pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));

  const result: SyncResult = { pushed: 0, failed: 0, skipped: all.length - pending.length, errors: [] };
  for (const item of pending) {
    try {
      await applyToReplica(item, !!opts.simulateFail);
      await db.outbox.update(item.key, { status: 'synced', syncedAt: new Date().toISOString(), lastError: undefined });
      result.pushed += 1;
    } catch (e) {
      const attempts = item.attempts + 1;
      const lastError = (e as Error).message;
      await db.outbox.update(item.key, { status: 'failed', attempts, lastError });
      result.failed += 1;
      result.errors.push({ key: item.key, error: lastError });
    }
  }
  await db.syncMeta.put({ key: `${side}:lastSyncAt`, value: new Date().toISOString() });
  return result;
}

/** 仅重试失败项（已对上的不动） */
export async function retryFailed(side: Side, opts: { simulateFail?: boolean } = {}): Promise<SyncResult> {
  return syncSide(side, opts);
}

export interface OutboxCounts {
  pending: number;
  failed: number;
  synced: number;
}

/** 本侧发件箱各状态计数 */
export async function outboxCounts(side: Side): Promise<OutboxCounts> {
  const items = await db.outbox.where('side').equals(side).toArray();
  return {
    pending: items.filter((it) => it.status === 'pending').length,
    failed: items.filter((it) => it.status === 'failed').length,
    synced: items.filter((it) => it.status === 'synced').length,
  };
}

/** 本侧发件箱明细（按状态与时间排序） */
export async function outboxItems(side: Side): Promise<OutboxItem[]> {
  const items = await db.outbox.where('side').equals(side).toArray();
  const order: Record<OutboxItem['status'], number> = { failed: 0, pending: 1, synced: 2 };
  return items.sort((a, b) => order[a.status] - order[b.status] || b.createdAt.localeCompare(a.createdAt));
}

/** 本侧上次同步时间 */
export async function lastSyncAt(side: Side): Promise<string | undefined> {
  const row = await db.syncMeta.get(`${side}:lastSyncAt`);
  return row?.value;
}
