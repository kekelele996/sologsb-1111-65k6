import type { SyncFields } from './sync';

export type QcConclusionType = '通过' | '返工核实' | '异常待裁定';

/** 编录室质检结论，按孔和深度段落库 */
export interface QualityConclusion extends SyncFields {
  id: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  conclusion: QcConclusionType;
  sampleNo: string;
  inspector: string;
  checkedAt: string;
  remark?: string;
}

export const QC_CONCLUSIONS: QcConclusionType[] = ['通过', '返工核实', '异常待裁定'];
