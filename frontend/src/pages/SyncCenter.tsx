import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { TableColumnsType, UploadProps } from 'antd';
import { CloudSyncOutlined, DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { activeSide, db } from '../utils/db';
import { useHoleStore } from '../stores/holeStore';
import { useRunStore } from '../stores/runStore';
import { useBoxStore } from '../stores/boxStore';
import { useLithoStore } from '../stores/lithoStore';
import { useQcStore } from '../stores/qcStore';
import { SIDE_LABEL, type DepthConflict, type OutboxItem, type SyncAck } from '../types/sync';
import { downloadText } from '../utils/export';
import {
  applySyncPacket,
  buildOutgoingPacket,
  deliverDirectly,
  importSyncAck,
  listConflicts,
  parseSyncAck,
  parseSyncPacket,
  resolveConflict,
} from '../utils/syncEngine';

const { Title, Paragraph, Text } = Typography;
const { TextArea } = Input;

const statusColor: Record<OutboxItem['status'], string> = {
  pending: 'blue',
  failed: 'red',
  delivered: 'green',
};

const statusText: Record<OutboxItem['status'], string> = {
  pending: '待送交',
  failed: '失败待重试',
  delivered: '已对上',
};

const entityLabel: Record<OutboxItem['entityType'], string> = {
  holes: '钻孔主档',
  runs: '回次',
  boxes: '岩芯箱',
  lithos: '岩性区间',
  qcs: '质检结论',
};

/** 同步对账中心：本侧 outbox、对端同步包、深度段冲突人工裁定 */
export default function SyncCenter() {
  const { message } = AntApp.useApp();
  const holes = useHoleStore((s) => s.holes);
  const hydrateHoles = useHoleStore((s) => s.hydrate);
  const hydrateRuns = useRunStore((s) => s.hydrate);
  const hydrateBoxes = useBoxStore((s) => s.hydrate);
  const hydrateLithos = useLithoStore((s) => s.hydrate);
  const hydrateQcs = useQcStore((s) => s.hydrate);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [conflicts, setConflicts] = useState<DepthConflict[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [resolving, setResolving] = useState<DepthConflict | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [decision, setDecision] = useState<DepthConflict['decision']>('hold');

  const refresh = async () => {
    const [items, pendingConflicts] = await Promise.all([
      db.outbox.orderBy('updatedAt').reverse().toArray(),
      listConflicts(activeSide),
    ]);
    setOutbox(items);
    setConflicts(pendingConflicts.sort((a, b) => a.holeId.localeCompare(b.holeId) || a.fromDepth - b.fromDepth));
  };

  useEffect(() => {
    refresh();
    const goOnline = () => {
      setOnline(true);
      message.success('网络恢复，可重试本机待送交变更');
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [message]);

  const hydrateAll = () => Promise.all([hydrateHoles(), hydrateRuns(), hydrateBoxes(), hydrateLithos(), hydrateQcs()]);

  const counts = useMemo(
    () => ({
      pending: outbox.filter((item) => item.status === 'pending').length,
      failed: outbox.filter((item) => item.status === 'failed').length,
      delivered: outbox.filter((item) => item.status === 'delivered').length,
      conflict: conflicts.filter((item) => item.status === 'pending').length,
    }),
    [outbox, conflicts],
  );

  const retryDirect = async () => {
    const result = await deliverDirectly(activeSide);
    await hydrateAll();
    await refresh();
    if (result.ack.errors.length) {
      message.warning(`完成 ${result.ack.appliedChangeIds.length} 条；失败 ${result.ack.errors.length} 条，已保留在本侧重试`);
    } else {
      message.success(`已与对端对上 ${result.ack.appliedChangeIds.length} 条变更`);
    }
  };

  const exportPacket = async () => {
    const packet = await buildOutgoingPacket(activeSide);
    if (packet.changes.length === 0) {
      message.info('没有待送交或失败待重试的变更；已对上的记录不会重复挂出');
      return;
    }
    downloadText(`gbdrillcore-${activeSide}-sync-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(packet, null, 2));
    message.success(`已生成 ${packet.changes.length} 条本侧变更，断网也可带回驻地`);
  };

  const uploadPacket: UploadProps['beforeUpload'] = async (file) => {
    try {
      const text = await file.text();
      const packet = parseSyncPacket(text);
      const result = await applySyncPacket(packet, activeSide);
      await hydrateAll();
      await refresh();
      downloadText(
        `gbdrillcore-${activeSide}-ack-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(result.ack, null, 2),
      );
      message.success(`已收 ${result.ack.appliedChangeIds.length} 条，回执文件已生成；请交回发送端消单`);
      if (result.ack.errors.length) message.warning(`${result.ack.errors.length} 条变更未处理，已写入回执`);
    } catch (error) {
      message.error(`同步包导入失败：${(error as Error).message}`);
    }
    return false;
  };

  const uploadAck: UploadProps['beforeUpload'] = async (file) => {
    try {
      const text = await file.text();
      const ack: SyncAck = parseSyncAck(text);
      const result = await importSyncAck(ack, activeSide);
      await refresh();
      message.success(`回执已处理：${result.delivered} 条消单，${result.failed} 条保留待重试`);
    } catch (error) {
      message.error(`回执导入失败：${(error as Error).message}`);
    }
    return false;
  };

  const submitResolution = async () => {
    if (!resolving) return;
    await resolveConflict(activeSide, resolving.id, decision, resolutionNote);
    message.success('裁定已记录；只处理该深度段，不影响其他段');
    setResolving(null);
    await refresh();
  };

  const holeNoOf = (holeId: string) => holes.find((hole) => hole.id === holeId)?.holeNo ?? '未知孔';

  const outboxColumns: TableColumnsType<OutboxItem> = [
    { title: '归属数据', width: 110, render: (_, row) => entityLabel[row.entityType] },
    { title: '实体 ID', dataIndex: 'entityId', width: 210, ellipsis: true },
    { title: '版本', dataIndex: 'revision', width: 70, align: 'right' },
    { title: '动作', dataIndex: 'operation', width: 80, render: (v) => (v === 'delete' ? '删除' : '保存') },
    { title: '状态', dataIndex: 'status', width: 110, render: (v: OutboxItem['status']) => <Tag color={statusColor[v]}>{statusText[v]}</Tag> },
    { title: '尝试次数', dataIndex: 'attempts', width: 90, align: 'right' },
    { title: '最近错误', dataIndex: 'lastError', ellipsis: true, render: (v?: string) => v || '-' },
    { title: '更新时间', dataIndex: 'updatedAt', width: 170, render: (v: string) => new Date(v).toLocaleString() },
  ];

  const conflictColumns: TableColumnsType<DepthConflict> = [
    { title: '孔号', width: 100, render: (_, row) => <Text strong>{holeNoOf(row.holeId)}</Text> },
    { title: '待裁定深度(m)', width: 150, render: (_, row) => `${row.fromDepth}~${row.toDepth}` },
    { title: '对账问题', dataIndex: 'reason', width: 210 },
    { title: '现场端引用', dataIndex: 'fieldRef', width: 220, ellipsis: true, render: (v?: string) => v ?? '-' },
    { title: '编录室端引用', dataIndex: 'officeRef', width: 240, ellipsis: true, render: (v?: string) => v ?? '-' },
    { title: '状态', dataIndex: 'status', width: 100, render: (v: DepthConflict['status']) => (v === 'pending' ? <Tag color="red">待裁定</Tag> : <Tag color="green">已裁定</Tag>) },
    {
      title: '操作',
      width: 100,
      render: (_, row) =>
        row.status === 'pending' ? (
          <Button
            size="small"
            type="link"
            onClick={() => {
              setResolving(row);
              setDecision('hold');
              setResolutionNote('');
            }}
          >
            人工裁定
          </Button>
        ) : (
          <Text type="secondary">{row.resolutionNote}</Text>
        ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>同步与深度对账</Title>
      <Paragraph type="secondary">
        当前为{SIDE_LABEL[activeSide]}，只送交本侧归属数据。断网期间继续录入，失败单留在本机；版本已对上的记录不会重复挂出。对不上的深度段按孔列出来等待人工裁定。
      </Paragraph>

      <Alert
        style={{ marginBottom: 16 }}
        type={online ? 'success' : 'warning'}
        showIcon
        message={online ? '网络在线：可回驻地支点重试/直连送交' : '当前断网：数据正常写入本机，待回驻地后再同步'}
      />

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}><Card><Statistic title="待送交" value={counts.pending} /></Card></Col>
        <Col xs={12} md={6}><Card><Statistic title="失败待重试" value={counts.failed} valueStyle={{ color: counts.failed ? '#cf1322' : undefined }} /></Card></Col>
        <Col xs={12} md={6}><Card><Statistic title="已对上" value={counts.delivered} valueStyle={{ color: '#389e0d' }} /></Card></Col>
        <Col xs={12} md={6}><Card><Statistic title="待裁定深度段" value={counts.conflict} valueStyle={{ color: counts.conflict ? '#cf1322' : undefined }} /></Card></Col>
      </Row>

      <Card
        title={<Space><CloudSyncOutlined />送交队列</Space>}
        style={{ marginBottom: 16 }}
        extra={
          <Space wrap>
            <Button onClick={refresh}>刷新</Button>
            <Popconfirm title="将本侧待送交/失败单送交驻地支点上的对端库？" onConfirm={retryDirect}>
              <Button type="primary" disabled={!online}>驻地支点重试/直连</Button>
            </Popconfirm>
            <Button icon={<DownloadOutlined />} onClick={exportPacket}>导出本侧同步包</Button>
            <Upload accept="application/json,.json" showUploadList={false} beforeUpload={uploadAck}>
              <Button icon={<UploadOutlined />}>导入对端回执</Button>
            </Upload>
          </Space>
        }
      >
        <Table rowKey="id" size="small" columns={outboxColumns} dataSource={outbox} pagination={{ pageSize: 6 }} scroll={{ x: 1050 }} />
      </Card>

      <Card
        title={<Space><Badge color={counts.conflict ? '#cf1322' : '#389e0d'} text={`按孔深度对账（${counts.conflict} 段待裁定）`} /></Space>}
        extra={
          <Upload accept="application/json,.json" showUploadList={false} beforeUpload={uploadPacket}>
            <Button type="primary" ghost icon={<UploadOutlined />}>导入对端同步包并对账</Button>
          </Upload>
        }
      >
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message="冲突只标记具体孔深段；其他已对上的回次、装箱、岩性、样品和质检结论照常同步与使用。"
        />
        <Table rowKey="id" size="small" columns={conflictColumns} dataSource={conflicts} pagination={{ pageSize: 8 }} scroll={{ x: 1250 }} />
      </Card>

      <Modal
        open={Boolean(resolving)}
        title={resolving ? `人工裁定 · ${holeNoOf(resolving.holeId)} ${resolving.fromDepth}~${resolving.toDepth}m` : ''}
        onCancel={() => setResolving(null)}
        onOk={submitResolution}
        okText="保存裁定"
        cancelText="取消"
      >
        <Form layout="vertical">
          <Form.Item label="裁定方向">
            <Space wrap>
              <Button type={decision === 'field' ? 'primary' : 'default'} onClick={() => setDecision('field')}>按现场深度/回次处理</Button>
              <Button type={decision === 'office' ? 'primary' : 'default'} onClick={() => setDecision('office')}>按编录室岩性/样品处理</Button>
              <Button type={decision === 'hold' ? 'primary' : 'default'} danger onClick={() => setDecision('hold')}>继续挂起</Button>
            </Space>
          </Form.Item>
          <Form.Item label="裁定说明">
            <TextArea rows={4} value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} placeholder="记录复核人、依据和后续处理；系统不会擅自改写任一侧原始记录" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
