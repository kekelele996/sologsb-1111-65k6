import { create } from 'zustand';
import { activeSide, db } from '../utils/db';
import { uid } from '../utils/id';
import { buildOutboxItem, stampNew, stampUpdate } from '../utils/syncData';
import type { DrillHole, HoleProgress, SurveyPoint } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import { buildHoleProgress } from '../utils/recovery';
import { useRunStore } from './runStore';
import { useBoxStore } from './boxStore';

export interface HoleInput {
  holeNo: string;
  coordX: number;
  coordY: number;
  collarElevation: number;
  designDepth: number;
  finalDepth: number;
  startDate: string;
  endDate?: string;
  rigNo: string;
  shift: string;
  surveyData: SurveyPoint[];
  remark?: string;
}

interface HoleState {
  holes: DrillHole[];
  currentHoleId: string;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setCurrentHole: (id: string) => void;
  addHole: (input: HoleInput) => Promise<DrillHole>;
  updateHole: (id: string, patch: Partial<HoleInput>) => Promise<void>;
  removeHole: (id: string) => Promise<void>;
  /** 当前钻孔 */
  currentHole: () => DrillHole | undefined;
}

/** 钻孔台帐与当前孔 */
export const useHoleStore = create<HoleState>()((set, get) => ({
  holes: [],
  currentHoleId: '',
  hydrated: false,

  hydrate: async () => {
    const holes = await db.holes.orderBy('holeNo').toArray();
    set({ holes, currentHoleId: get().currentHoleId || holes[0]?.id || '', hydrated: true });
  },

  setCurrentHole: (id) => set({ currentHoleId: id }),

  addHole: async (input) => {
    if (activeSide !== 'field') throw new Error('钻孔主档随现场开孔数据维护');
    const base = {
      id: uid('hole'),
      holeNo: input.holeNo.trim(),
      coordX: Number(input.coordX) || 0,
      coordY: Number(input.coordY) || 0,
      collarElevation: Number(input.collarElevation) || 0,
      designDepth: Number(input.designDepth) || 0,
      finalDepth: Number(input.finalDepth) || 0,
      startDate: input.startDate,
      endDate: input.endDate || undefined,
      rigNo: input.rigNo,
      shift: input.shift,
      surveyData: input.surveyData,
      remark: input.remark?.trim() || undefined,
    };
    const hole = stampNew(base, 'holes');
    const outbox = buildOutboxItem({
      side: activeSide,
      entityType: 'holes',
      entityId: hole.id,
      revision: hole.revision,
      operation: 'upsert',
      payload: hole,
    });
    await db.transaction('rw', db.holes, db.outbox, async () => {
      await db.holes.put(hole);
      await db.outbox.put(outbox);
    });
    set({ holes: [...get().holes, hole].sort((a, b) => a.holeNo.localeCompare(b.holeNo)), currentHoleId: hole.id });
    return hole;
  },

  updateHole: async (id, patch) => {
    const current = get().holes.find((h) => h.id === id);
    if (!current || current.ownerSide !== activeSide) return;
    const next = stampUpdate({ ...current, ...patch }, {});
    const outbox = buildOutboxItem({
      side: activeSide,
      entityType: 'holes',
      entityId: next.id,
      revision: next.revision,
      operation: 'upsert',
      payload: next,
    });
    await db.transaction('rw', db.holes, db.outbox, async () => {
      await db.holes.put(next);
      await db.outbox.put(outbox);
    });
    set({ holes: get().holes.map((h) => (h.id === id ? next : h)) });
  },

  removeHole: async (id) => {
    const current = get().holes.find((h) => h.id === id);
    if (current?.ownerSide !== activeSide) return;
    const [runs, boxes] = await Promise.all([db.runs.where('holeId').equals(id).toArray(), db.boxes.where('holeId').equals(id).toArray()]);
    await db.transaction('rw', db.holes, db.runs, db.boxes, db.outbox, async () => {
      await db.holes.delete(id);
      await db.runs.bulkDelete(runs.map((r) => r.id));
      await db.boxes.bulkDelete(boxes.map((b) => b.id));
      if (current?.ownerSide === activeSide) {
        await db.outbox.put(
          buildOutboxItem({
            side: activeSide,
            entityType: 'holes',
            entityId: id,
            revision: current.revision + 1,
            operation: 'delete',
          }),
        );
      }
      for (const run of runs) {
        if (run.ownerSide === activeSide) {
          await db.outbox.put(
            buildOutboxItem({
              side: activeSide,
              entityType: 'runs',
              entityId: run.id,
              revision: run.revision + 1,
              operation: 'delete',
            }),
          );
        }
      }
      for (const box of boxes) {
        if (box.ownerSide === activeSide) {
          await db.outbox.put(
            buildOutboxItem({
              side: activeSide,
              entityType: 'boxes',
              entityId: box.id,
              revision: box.revision + 1,
              operation: 'delete',
            }),
          );
        }
      }
    });
    const runIds = new Set(runs.map((r) => r.id));
    const boxIds = new Set(boxes.map((b) => b.id));
    set({
      holes: get().holes.filter((h) => h.id !== id),
    });
    useRunStore.setState((state) => ({ runs: state.runs.filter((r) => !runIds.has(r.id)) }));
    useBoxStore.setState((state) => ({ boxes: state.boxes.filter((b) => !boxIds.has(b.id)) }));
  },

  currentHole: () => get().holes.find((h) => h.id === get().currentHoleId),
}));

/** 钻孔进度派生（终孔深度 / 未达设计 / 待补勘） */
export function holeProgressList(holes: DrillHole[], runs: DrillRun[]): HoleProgress[] {
  return holes.map((hole) => buildHoleProgress(hole, runs.filter((run) => run.holeId === hole.id)));
}
