import { useSideStore, type Side } from '../stores/sideStore';
import { canEdit, type EntityName } from '../utils/ownership';

/** 当前端别是否拥有某实体的编辑权（非归属方只能看同步副本） */
export function useCanEdit(entity: EntityName): boolean {
  const side = useSideStore((s) => s.side);
  return canEdit(side, entity);
}

/** 当前端别 */
export function useSide(): Side {
  return useSideStore((s) => s.side);
}
