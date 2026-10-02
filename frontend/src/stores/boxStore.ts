import { create } from 'zustand';
import { activeSide, db } from '../utils/db';
import { uid } from '../utils/id';
import { buildOutboxItem, stampNew, stampUpdate } from '../utils/syncData';
import type { CoreBox } from '../types/core-box';

export interface BoxInput {
  boxNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  slots: number;
  slotLength: number;
  boxedAt: string;
  shelfPos: string;
  damagedSlots: number[];
  operator: string;
  remark?: string;
}

interface BoxState {
  boxes: CoreBox[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addBox: (input: BoxInput) => Promise<CoreBox>;
  updateBox: (id: string, patch: Partial<BoxInput>) => Promise<void>;
  removeBox: (id: string) => Promise<void>;
  /** 标记/取消破损格 */
  toggleDamagedSlot: (id: string, slot: number) => Promise<void>;
}

/** 岩芯箱与格位分配 */
export const useBoxStore = create<BoxState>()((set, get) => ({
  boxes: [],
  hydrated: false,

  hydrate: async () => {
    const boxes = await db.boxes.orderBy('boxNo').toArray();
    set({ boxes, hydrated: true });
  },

  addBox: async (input) => {
    if (activeSide !== 'field') throw new Error('岩芯箱装箱只归现场端维护');
    const base = {
      id: uid('box'),
      boxNo: input.boxNo.trim(),
      holeId: input.holeId,
      fromDepth: Number(input.fromDepth) || 0,
      toDepth: Number(input.toDepth) || 0,
      slots: Number(input.slots) || 0,
      slotLength: Number(input.slotLength) || 0,
      boxedAt: input.boxedAt,
      shelfPos: input.shelfPos,
      damagedSlots: input.damagedSlots ?? [],
      operator: input.operator.trim(),
      remark: input.remark?.trim() || undefined,
    };
    const box = stampNew(base, 'boxes');
    const outbox = buildOutboxItem({
      side: activeSide,
      entityType: 'boxes',
      entityId: box.id,
      revision: box.revision,
      operation: 'upsert',
      payload: box,
    });
    await db.transaction('rw', db.boxes, db.outbox, async () => {
      await db.boxes.put(box);
      await db.outbox.put(outbox);
    });
    set({ boxes: [...get().boxes, box] });
    return box;
  },

  updateBox: async (id, patch) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current || current.ownerSide !== activeSide) return;
    const next = stampUpdate({ ...current, ...patch }, {});
    const outbox = buildOutboxItem({
      side: activeSide,
      entityType: 'boxes',
      entityId: next.id,
      revision: next.revision,
      operation: 'upsert',
      payload: next,
    });
    await db.transaction('rw', db.boxes, db.outbox, async () => {
      await db.boxes.put(next);
      await db.outbox.put(outbox);
    });
    set({ boxes: get().boxes.map((b) => (b.id === id ? next : b)) });
  },

  removeBox: async (id) => {
    const current = get().boxes.find((b) => b.id === id);
    await db.transaction('rw', db.boxes, db.outbox, async () => {
      await db.boxes.delete(id);
      if (current?.ownerSide === activeSide) {
        await db.outbox.put(
          buildOutboxItem({
            side: activeSide,
            entityType: 'boxes',
            entityId: id,
            revision: current.revision + 1,
            operation: 'delete',
          }),
        );
      }
    });
    set({ boxes: get().boxes.filter((b) => b.id !== id) });
  },

  toggleDamagedSlot: async (id, slot) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current || current.ownerSide !== activeSide) return;
    const damagedSlots = current.damagedSlots.includes(slot)
      ? current.damagedSlots.filter((s) => s !== slot)
      : [...current.damagedSlots, slot].sort((a, b) => a - b);
    const next = stampUpdate(current, { damagedSlots });
    const outbox = buildOutboxItem({
      side: activeSide,
      entityType: 'boxes',
      entityId: next.id,
      revision: next.revision,
      operation: 'upsert',
      payload: next,
    });
    await db.transaction('rw', db.boxes, db.outbox, async () => {
      await db.boxes.put(next);
      await db.outbox.put(outbox);
    });
    set({ boxes: get().boxes.map((b) => (b.id === id ? next : b)) });
  },
}));
