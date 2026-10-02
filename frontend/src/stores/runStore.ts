import { create } from 'zustand';
import { activeSide, db } from '../utils/db';
import { uid } from '../utils/id';
import { buildOutboxItem, stampNew, stampUpdate } from '../utils/syncData';
import type { DrillRun, RunAnomaly, RunShift } from '../types/drill-run';
import { footageOf, gradeOf, isAnomaly, recoveryOf, RECOVERY_GRADE_TEXT } from '../utils/recovery';

export interface RunInput {
  runNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  coreLength: number;
  waterLevel: number;
  shift: RunShift;
  drilledAt: string;
  recorder: string;
  remark?: string;
}

interface RunState {
  runs: DrillRun[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addRun: (input: RunInput) => Promise<DrillRun>;
  updateRun: (id: string, patch: Partial<RunInput>) => Promise<void>;
  removeRun: (id: string) => Promise<void>;
  removeByHole: (holeId: string) => Promise<void>;
}

/** 回次与采取率派生值：进尺与采取率均由起止深度、岩芯长度自动计算 */
export const useRunStore = create<RunState>()((set, get) => ({
  runs: [],
  hydrated: false,

  hydrate: async () => {
    const runs = await db.runs.orderBy('fromDepth').toArray();
    set({ runs, hydrated: true });
  },

  addRun: async (input) => {
    if (activeSide !== 'field') throw new Error('回次进尺和采取率只归现场端维护');
    const footage = footageOf(input.fromDepth, input.toDepth);
    const base = {
      id: uid('run'),
      runNo: input.runNo.trim(),
      holeId: input.holeId,
      fromDepth: Number(input.fromDepth) || 0,
      toDepth: Number(input.toDepth) || 0,
      footage,
      coreLength: Number(input.coreLength) || 0,
      recovery: recoveryOf(input.coreLength, footage),
      waterLevel: Number(input.waterLevel) || 0,
      shift: input.shift,
      drilledAt: input.drilledAt,
      recorder: input.recorder.trim(),
      remark: input.remark?.trim() || undefined,
    };
    const run = stampNew(base, 'runs');
    const outbox = buildOutboxItem({
      side: activeSide,
      entityType: 'runs',
      entityId: run.id,
      revision: run.revision,
      operation: 'upsert',
      payload: run,
    });
    await db.transaction('rw', db.runs, db.outbox, async () => {
      await db.runs.put(run);
      await db.outbox.put(outbox);
    });
    set({ runs: [run, ...get().runs] });
    return run;
  },

  updateRun: async (id, patch) => {
    const current = get().runs.find((r) => r.id === id);
    if (!current) return;
    if (current.ownerSide !== activeSide) throw new Error('不能修改对端回次记录');
    const merged = { ...current, ...patch };
    const footage = footageOf(merged.fromDepth, merged.toDepth);
    const next = stampUpdate(merged, {
      footage,
      recovery: recoveryOf(merged.coreLength, footage),
    });
    const outbox = buildOutboxItem({
      side: activeSide,
      entityType: 'runs',
      entityId: next.id,
      revision: next.revision,
      operation: 'upsert',
      payload: next,
    });
    await db.transaction('rw', db.runs, db.outbox, async () => {
      await db.runs.put(next);
      await db.outbox.put(outbox);
    });
    set({ runs: get().runs.map((r) => (r.id === id ? next : r)) });
  },

  removeRun: async (id) => {
    const current = get().runs.find((r) => r.id === id);
    if (current?.ownerSide !== activeSide) return;
    await db.transaction('rw', db.runs, db.outbox, async () => {
      await db.runs.delete(id);
      if (current?.ownerSide === activeSide) {
        await db.outbox.put(
          buildOutboxItem({
            side: activeSide,
            entityType: 'runs',
            entityId: id,
            revision: current.revision + 1,
            operation: 'delete',
          }),
        );
      }
    });
    set({ runs: get().runs.filter((r) => r.id !== id) });
  },

  removeByHole: async (holeId) => {
    const removable = get().runs.filter((r) => r.holeId === holeId);
    await db.transaction('rw', db.runs, db.outbox, async () => {
      const ids: string[] = [];
      for (const run of removable) {
        ids.push(run.id);
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
      await db.runs.bulkDelete(ids);
    });
    set({ runs: get().runs.filter((r) => r.holeId !== holeId) });
  },
}));

/** 采取率异常清单（低于 75% 判异常） */
export function anomalyList(runs: DrillRun[], holeNoOf: (holeId: string) => string): RunAnomaly[] {
  return runs
    .filter((run) => isAnomaly(run.recovery))
    .map((run) => ({
      run,
      holeNo: holeNoOf(run.holeId),
      grade: gradeOf(run.recovery),
      advice: RECOVERY_GRADE_TEXT.异常.advice,
    }))
    .sort((a, b) => a.run.recovery - b.run.recovery);
}
