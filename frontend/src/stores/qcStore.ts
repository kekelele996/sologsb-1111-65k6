import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { readTable, writeTable } from '../utils/ownership';
import { enqueue } from '../utils/syncEngine';
import { useSideStore } from './sideStore';
import type { QcConclusion, QcItem, QcRecord } from '../types/qc';

export interface QcInput {
  holeId: string;
  fromDepth: number;
  toDepth: number;
  item: QcItem;
  conclusion: QcConclusion;
  inspector: string;
  inspectedAt: string;
  remark?: string;
}

interface QcState {
  qcList: QcRecord[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addQc: (input: QcInput) => Promise<QcRecord>;
  updateQc: (id: string, patch: Partial<QcInput>) => Promise<void>;
  removeQc: (id: string) => Promise<void>;
}

/** 质检结论：编录室端持有与编辑；现场端只读同步副本 */
export const useQcStore = create<QcState>()((set, get) => ({
  qcList: [],
  hydrated: false,

  hydrate: async () => {
    const side = useSideStore.getState().side;
    const rows = await readTable(side, 'qc').orderBy('fromDepth').toArray();
    set({ qcList: rows, hydrated: true });
  },

  addQc: async (input) => {
    const side = useSideStore.getState().side;
    const table = writeTable(side, 'qc'); // 非归属端调用会抛错
    const record: QcRecord = {
      id: uid('qc'),
      holeId: input.holeId,
      fromDepth: Number(input.fromDepth) || 0,
      toDepth: Number(input.toDepth) || 0,
      item: input.item,
      conclusion: input.conclusion,
      inspector: input.inspector.trim(),
      inspectedAt: input.inspectedAt,
      remark: input.remark?.trim() || undefined,
    };
    await table.put(record);
    await enqueue(side, 'qc', 'upsert', record.id, record);
    set({ qcList: [...get().qcList, record].sort((a, b) => a.fromDepth - b.fromDepth) });
    return record;
  },

  updateQc: async (id, patch) => {
    const side = useSideStore.getState().side;
    const table = writeTable(side, 'qc');
    const current = get().qcList.find((q) => q.id === id);
    if (!current) return;
    const next: QcRecord = {
      ...current,
      ...patch,
      fromDepth: patch.fromDepth !== undefined ? Number(patch.fromDepth) || 0 : current.fromDepth,
      toDepth: patch.toDepth !== undefined ? Number(patch.toDepth) || 0 : current.toDepth,
      inspector: patch.inspector !== undefined ? patch.inspector.trim() : current.inspector,
      remark: patch.remark !== undefined ? patch.remark.trim() || undefined : current.remark,
    };
    await table.put(next);
    await enqueue(side, 'qc', 'upsert', next.id, next);
    set({ qcList: get().qcList.map((q) => (q.id === id ? next : q)) });
  },

  removeQc: async (id) => {
    const side = useSideStore.getState().side;
    const table = writeTable(side, 'qc');
    await table.delete(id);
    await enqueue(side, 'qc', 'delete', id, null);
    set({ qcList: get().qcList.filter((q) => q.id !== id) });
  },
}));
