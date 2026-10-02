import { db } from './db';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { LithoLog } from '../types/litho-log';
import type { CoreBox } from '../types/core-box';
import { gapsWithin, rangesOverlap } from './recovery';

export type MismatchType = 'depth' | 'runWithoutLog' | 'logWithoutRun' | 'boxGap' | 'holeDepth';

export interface Mismatch {
  /** 稳定主键，便于叠加裁定结论 */
  id: string;
  holeId: string;
  holeNo: string;
  type: MismatchType;
  depthFrom: number;
  depthTo: number;
  /** 现场端（班组）侧的描述与值 */
  fieldLabel: string;
  fieldValue: string;
  /** 编录室端侧的描述与值 */
  catalogLabel: string;
  catalogValue: string;
  status: 'pending' | 'resolved';
  decision?: 'field' | 'catalog' | 'agree';
  resolvedBy?: string;
  resolvedAt?: string;
  note?: string;
}

export const MISMATCH_TYPE_TEXT: Record<MismatchType, string> = {
  depth: '深度不一致',
  runWithoutLog: '有回次无编录',
  logWithoutRun: '有编录无回次',
  boxGap: '岩芯箱断档',
  holeDepth: '终孔深度不一致',
};

/** 深度比对容差（m）：边界差超过容差才报不一致 */
const TOL = 0.5;

function build(
  hole: DrillHole,
  type: MismatchType,
  depthFrom: number,
  depthTo: number,
  fieldLabel: string,
  fieldValue: string,
  catalogLabel: string,
  catalogValue: string,
  suffix: string,
): Mismatch {
  return {
    id: `${hole.id}:${type}:${suffix}`,
    holeId: hole.id,
    holeNo: hole.holeNo,
    type,
    depthFrom: Number(depthFrom.toFixed(2)),
    depthTo: Number(depthTo.toFixed(2)),
    fieldLabel,
    fieldValue,
    catalogLabel,
    catalogValue,
    status: 'pending',
  };
}

/**
 * 两边对账：按孔 + 深度摆出现场端（回次/岩芯箱/终孔）与编录室端（岩性区间）对不上的地方。
 * 只读取双方主表，不改动任何业务数据；裁定结论单独持久化，不阻塞其他段。
 */
export async function computeMismatches(): Promise<Mismatch[]> {
  const [holes, runs, boxes, lithos, storedRows] = await Promise.all([
    db.holes.toArray(),
    db.runs.toArray(),
    db.boxes.toArray(),
    db.lithos.toArray(),
    db.reconcile.toArray(),
  ]);
  const storedMap = new Map(storedRows.map((s) => [s.id, s]));
  const list: Mismatch[] = [];

  for (const hole of holes) {
    const hRuns = runs.filter((r) => r.holeId === hole.id).sort((a, b) => a.fromDepth - b.fromDepth);
    const hBoxes = boxes.filter((b) => b.holeId === hole.id);
    const hLithos = lithos.filter((l) => l.holeId === hole.id).sort((a, b) => a.fromDepth - b.fromDepth);

    // 1) 深度不一致：回次与岩性区间重叠但边界差超过容差
    for (const run of hRuns) {
      const overlaps = hLithos.filter((l) => rangesOverlap(run.fromDepth, run.toDepth, l.fromDepth, l.toDepth));
      for (const litho of overlaps) {
        const fromDiff = Math.abs(run.fromDepth - litho.fromDepth);
        const toDiff = Math.abs(run.toDepth - litho.toDepth);
        if (fromDiff > TOL || toDiff > TOL) {
          list.push(
            build(
              hole,
              'depth',
              Math.min(run.fromDepth, litho.fromDepth),
              Math.max(run.toDepth, litho.toDepth),
              `回次 ${run.runNo} 深度 ${run.fromDepth}~${run.toDepth}m`,
              `采取率 ${run.recovery}% / 进尺 ${run.footage}m`,
              `岩性区间 ${litho.fromDepth}~${litho.toDepth}m`,
              `${litho.lithology} / 样品 ${litho.sampleNo || '无'}`,
              `${run.id}:${litho.id}`,
            ),
          );
        }
      }
    }

    // 2) 有回次无编录：回次区间不与任何岩性区间重叠
    for (const run of hRuns) {
      const hasLog = hLithos.some((l) => rangesOverlap(run.fromDepth, run.toDepth, l.fromDepth, l.toDepth));
      if (!hasLog) {
        list.push(
          build(
            hole,
            'runWithoutLog',
            run.fromDepth,
            run.toDepth,
            `回次 ${run.runNo} ${run.fromDepth}~${run.toDepth}m`,
            `采取率 ${run.recovery}%`,
            '无对应岩性编录',
            '编录室未收到该段',
            run.id,
          ),
        );
      }
    }

    // 3) 有编录无回次：岩性区间不与任何回次重叠
    for (const litho of hLithos) {
      const hasRun = hRuns.some((r) => rangesOverlap(r.fromDepth, r.toDepth, litho.fromDepth, litho.toDepth));
      if (!hasRun) {
        list.push(
          build(
            hole,
            'logWithoutRun',
            litho.fromDepth,
            litho.toDepth,
            '无对应回次',
            '现场未钻进该段',
            `岩性区间 ${litho.fromDepth}~${litho.toDepth}m`,
            `${litho.lithology} / 样品 ${litho.sampleNo || '无'}`,
            litho.id,
          ),
        );
      }
    }

    // 4) 岩芯箱断档：装箱区间未被回次完整覆盖
    for (const box of hBoxes) {
      const gaps = gapsWithin(box.fromDepth, box.toDepth, hRuns);
      if (gaps.length) {
        list.push(
          build(
            hole,
            'boxGap',
            box.fromDepth,
            box.toDepth,
            `箱 ${box.boxNo} 装箱 ${box.fromDepth}~${box.toDepth}m`,
            `断档 ${gaps.map((g) => `${g.from}~${g.to}`).join('、')}m`,
            '—',
            '编录室据此深度编录',
            box.id,
          ),
        );
      }
    }

    // 5) 终孔深度 vs 编录最大深度
    const maxRun = hRuns.reduce((m, r) => Math.max(m, r.toDepth), 0);
    const maxLitho = hLithos.reduce((m, l) => Math.max(m, l.toDepth), 0);
    const fieldDepth = Math.max(hole.finalDepth || 0, maxRun);
    if (hLithos.length && Math.abs(fieldDepth - maxLitho) > TOL) {
      list.push(
        build(
          hole,
          'holeDepth',
          Math.min(fieldDepth, maxLitho),
          Math.max(fieldDepth, maxLitho),
          '现场终孔 / 已钻进深度',
          `${fieldDepth}m`,
          '编录最大深度',
          `${maxLitho}m`,
          'hole',
        ),
      );
    }
  }

  // 叠加已裁定结论（按稳定主键匹配）
  return list
    .map((m) => {
      const stored = storedMap.get(m.id);
      return stored && stored.status === 'resolved' ? { ...m, ...stored } : m;
    })
    .sort((a, b) => a.holeNo.localeCompare(b.holeNo) || a.depthFrom - b.depthFrom || a.type.localeCompare(b.type));
}

/** 裁定一条不一致：记录结论与依据，不改动双方业务数据，也不影响其他段 */
export async function resolveMismatch(
  mismatch: Mismatch,
  decision: NonNullable<Mismatch['decision']>,
  note: string,
  resolvedBy: string,
): Promise<void> {
  const record: Mismatch = {
    ...mismatch,
    status: 'resolved',
    decision,
    note: note.trim() || undefined,
    resolvedBy: resolvedBy.trim() || undefined,
    resolvedAt: new Date().toISOString(),
  };
  await db.reconcile.put(record);
}

/** 撤销裁定（回到待裁定） */
export async function reopenMismatch(id: string): Promise<void> {
  await db.reconcile.delete(id);
}
