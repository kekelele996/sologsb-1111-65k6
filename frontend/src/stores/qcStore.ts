import { create } from 'zustand';
import { activeSide, db } from '../utils/db';
import { uid } from '../utils/id';
import { buildOutboxItem, stampNew, stampUpdate } from '../utils/syncData';
import type { QualityConclusion, QcConclusionType } from '../types/quality-control';

export interface QcInput {
  holeId: string;
  fromDepth: number;
  toDepth: number;
  conclusion: QcConclusionType;
  sampleNo: string;
  inspector: string;
  checkedAt: string;
  remark?: string;
}

interface QcState {
  qcs: QualityConclusion[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addQc: (input: QcInput) => Promise<QualityConclusion>;
  updateQc: (id: string, patch: Partial<QcInput>) => Promise<void>;
  removeQc: (id: string) => Promise<void>;
}

export const useQcStore = create<QcState>()((set, get) => ({
  qcs: [],
  hydrated: false,

  hydrate: async () => {
    const qcs = await db.qcs.orderBy('fromDepth').toArray();
    set({ qcs, hydrated: true });
  },

  addQc: async (input) => {
    if (activeSide !== 'office') throw new Error('质检结论只归编录室端维护');
    const base = {
      id: uid('qc'),
      holeId: input.holeId,
      fromDepth: Number(input.fromDepth) || 0,
      toDepth: Number(input.toDepth) || 0,
      conclusion: input.conclusion,
      sampleNo: input.sampleNo.trim(),
      inspector: input.inspector.trim(),
      checkedAt: input.checkedAt,
      remark: input.remark?.trim() || undefined,
    };
    const qc = stampNew(base, 'qcs');
    const outbox = buildOutboxItem({
      side: activeSide,
      entityType: 'qcs',
      entityId: qc.id,
      revision: qc.revision,
      operation: 'upsert',
      payload: qc,
    });
    await db.transaction('rw', db.qcs, db.outbox, async () => {
      await db.qcs.put(qc);
      await db.outbox.put(outbox);
    });
    set({ qcs: [...get().qcs, qc] });
    return qc;
  },

  updateQc: async (id, patch) => {
    const current = get().qcs.find((q) => q.id === id);
    if (!current || current.ownerSide !== activeSide) return;
    const next = stampUpdate({ ...current, ...patch }, {});
    const outbox = buildOutboxItem({
      side: activeSide,
      entityType: 'qcs',
      entityId: next.id,
      revision: next.revision,
      operation: 'upsert',
      payload: next,
    });
    await db.transaction('rw', db.qcs, db.outbox, async () => {
      await db.qcs.put(next);
      await db.outbox.put(outbox);
    });
    set({ qcs: get().qcs.map((q) => (q.id === id ? next : q)) });
  },

  removeQc: async (id) => {
    const current = get().qcs.find((q) => q.id === id);
    if (current?.ownerSide !== activeSide) return;
    await db.transaction('rw', db.qcs, db.outbox, async () => {
      await db.qcs.delete(id);
      if (current?.ownerSide === activeSide) {
        await db.outbox.put(
          buildOutboxItem({
            side: activeSide,
            entityType: 'qcs',
            entityId: id,
            revision: current.revision + 1,
            operation: 'delete',
          }),
        );
      }
    });
    set({ qcs: get().qcs.filter((q) => q.id !== id) });
  },
}));
