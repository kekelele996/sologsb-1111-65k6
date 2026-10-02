import type { WorkstationSide } from '../types/sync';

const STORAGE_KEY = 'gbdrillcore-active-side';

function normalize(side: string | null): WorkstationSide {
  return side === 'office' ? 'office' : 'field';
}

export function getActiveSide(): WorkstationSide {
  try {
    return normalize(localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'field';
  }
}

export function setActiveSide(side: WorkstationSide): void {
  localStorage.setItem(STORAGE_KEY, side);
}
