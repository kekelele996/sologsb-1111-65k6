import { create } from 'zustand';

/**
 * 端别：现场端（钻机班组）/ 编录室端（地质编录员）。
 * 两端各持一份数据，改动只落在自己这一侧，回到驻地再同步。
 */
export type Side = 'field' | 'catalog';

interface SideState {
  /** 当前操作端 */
  side: Side;
  /** 切换端别（持久化到本机，下次打开沿用） */
  setSide: (side: Side) => void;
}

const STORAGE_KEY = 'gbdrillcore-side';

function initialSide(): Side {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'field' || saved === 'catalog') return saved;
  } catch {
    /* 隐私模式等场景下忽略 */
  }
  return 'field';
}

/** 当前操作端别：现场端或编录室端 */
export const useSideStore = create<SideState>((set) => ({
  side: initialSide(),
  setSide: (side) => {
    try {
      localStorage.setItem(STORAGE_KEY, side);
    } catch {
      /* 忽略持久化失败 */
    }
    set({ side });
  },
}));
