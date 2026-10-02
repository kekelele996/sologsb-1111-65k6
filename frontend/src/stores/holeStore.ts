import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { writeTable } from '../utils/ownership';
import { enqueue } from '../utils/syncEngine';
import { useSideStore } from './sideStore';
import type { DrillHole, HoleProgress, SurveyPoint } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import { buildHoleProgress } from '../utils/recovery';

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

/** 钻孔台帐与当前孔（双方共享参考，任一侧均可维护，改动挂本侧发件箱） */
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
    const side = useSideStore.getState().side;
    const table = writeTable(side, 'holes');
    const hole: DrillHole = {
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
    await table.put(hole);
    await enqueue(side, 'holes', 'upsert', hole.id, hole);
    set({ holes: [...get().holes, hole].sort((a, b) => a.holeNo.localeCompare(b.holeNo)), currentHoleId: hole.id });
    return hole;
  },

  updateHole: async (id, patch) => {
    const side = useSideStore.getState().side;
    const table = writeTable(side, 'holes');
    const current = get().holes.find((h) => h.id === id);
    if (!current) return;
    const next: DrillHole = { ...current, ...patch };
    await table.put(next);
    await enqueue(side, 'holes', 'upsert', next.id, next);
    set({ holes: get().holes.map((h) => (h.id === id ? next : h)) });
  },

  removeHole: async (id) => {
    const side = useSideStore.getState().side;
    const table = writeTable(side, 'holes');
    await table.delete(id);
    await enqueue(side, 'holes', 'delete', id, null);
    set({ holes: get().holes.filter((h) => h.id !== id) });
  },

  currentHole: () => get().holes.find((h) => h.id === get().currentHoleId),
}));

/** 钻孔进度派生（终孔深度 / 未达设计 / 待补勘） */
export function holeProgressList(holes: DrillHole[], runs: DrillRun[]): HoleProgress[] {
  return holes.map((hole) => buildHoleProgress(hole, runs.filter((run) => run.holeId === hole.id)));
}
