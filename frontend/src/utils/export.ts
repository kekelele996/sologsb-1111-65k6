import { db, WORK_DB_SCHEMA_VERSION } from './db';

export interface BackupPayload {
  app: string;
  schemaVersion: number;
  side: 'field' | 'office';
  exportedAt: string;
  holes: unknown[];
  runs: unknown[];
  boxes: unknown[];
  lithos: unknown[];
  qcs: unknown[];
  outbox: unknown[];
  conflicts: unknown[];
  syncState: unknown[];
}

/** 汇总当前端别库的全部本地表为 JSON 备份 */
export async function buildBackup(): Promise<BackupPayload> {
  const [holes, runs, boxes, lithos, qcs, outbox, conflicts, syncState] = await Promise.all([
    db.holes.toArray(),
    db.runs.toArray(),
    db.boxes.toArray(),
    db.lithos.toArray(),
    db.qcs.toArray(),
    db.outbox.toArray(),
    db.conflicts.toArray(),
    db.syncState.toArray(),
  ]);
  return {
    app: 'gbdrillcore',
    schemaVersion: WORK_DB_SCHEMA_VERSION,
    side: db.name.includes('office') ? 'office' : 'field',
    exportedAt: new Date().toISOString(),
    holes,
    runs,
    boxes,
    lithos,
    qcs,
    outbox,
    conflicts,
    syncState,
  };
}

export async function exportBackupJson(): Promise<string> {
  return JSON.stringify(await buildBackup(), null, 2);
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导出 CSV（岩芯编目表打印用） */
export function downloadCsv<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  columns: Array<{ key: keyof T; title: string }>,
): void {
  const header = columns.map((c) => `"${c.title}"`).join(',');
  const body = rows
    .map((row) => columns.map((c) => `"${String(row[c.key] ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  downloadText(filename, `﻿${header}\n${body}`, 'text/csv');
}
