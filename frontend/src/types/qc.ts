/** 质检结论 */
export type QcConclusion = '合格' | '不合格' | '待复检';

/** 质检项 */
export type QcItem = '岩芯采取率' | '编录深度' | '样品代表性' | '岩性描述' | '装箱质量' | '其他';

/** 质检结论记录（编录室端持有） */
export interface QcRecord {
  id: string;
  /** 所属钻孔 */
  holeId: string;
  /** 起始深度（m） */
  fromDepth: number;
  /** 终止深度（m） */
  toDepth: number;
  /** 质检项 */
  item: QcItem;
  /** 质检结论 */
  conclusion: QcConclusion;
  /** 质检人 */
  inspector: string;
  /** 质检日期 ISO */
  inspectedAt: string;
  /** 备注 */
  remark?: string;
}

export const QC_ITEMS: QcItem[] = ['岩芯采取率', '编录深度', '样品代表性', '岩性描述', '装箱质量', '其他'];

export const QC_CONCLUSIONS: QcConclusion[] = ['合格', '不合格', '待复检'];
