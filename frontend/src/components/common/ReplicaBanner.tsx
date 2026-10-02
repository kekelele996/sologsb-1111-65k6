import { Alert, Tag } from 'antd';
import { SyncOutlined } from '@ant-design/icons';
import { useSideStore } from '../../stores/sideStore';
import { OWNER, SIDE_LABEL, canEdit, type EntityName } from '../../utils/ownership';

/**
 * 只读副本提示条：当前端别不是该数据归属方时，说明看到的是同步到达的只读副本，
 * 改动权在归属端，避免“班组补记回次带走编录区间”这类越权覆盖。
 */
export default function ReplicaBanner({ entity }: { entity: EntityName }) {
  const side = useSideStore((s) => s.side);
  if (canEdit(side, entity)) return null;
  const owner = OWNER[entity];
  const ownerText = owner === 'shared' ? '双方共享' : SIDE_LABEL[owner];
  return (
    <Alert
      style={{ marginBottom: 12 }}
      type="info"
      showIcon
      icon={<SyncOutlined />}
      message={
        <span>
          当前为 <Tag color="blue">{SIDE_LABEL[side]}</Tag> 看到的对方数据只读副本（归属：{ownerText}）。
        </span>
      }
      description="本段数据由归属端维护，同步到达后在此只读展示；如需改动，请切到归属端操作，或在「对账同步」中裁定。"
    />
  );
}
