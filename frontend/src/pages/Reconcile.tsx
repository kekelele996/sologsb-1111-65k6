import { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntApp, Badge, Button, Card, Col, Descriptions, Empty, Input, Modal, Radio, Row, Space, Statistic, Switch, Table, Tag, Timeline, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CheckCircleOutlined,
  CloudSyncOutlined,
  ReloadOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { useSideStore } from '../stores/sideStore';
import { SIDE_LABEL, SIDE_SHORT } from '../utils/ownership';
import {
  outboxCounts,
  outboxItems,
  retryFailed,
  syncSide,
  lastSyncAt,
  type OutboxCounts,
  type OutboxItem,
} from '../utils/syncEngine';
import {
  computeMismatches,
  resolveMismatch,
  reopenMismatch,
  MISMATCH_TYPE_TEXT,
  type Mismatch,
} from '../utils/reconcile';

const { Title, Paragraph, Text } = Typography;

const ENTITY_TEXT: Record<OutboxItem['entity'], string> = {
  holes: '钻孔台帐',
  runs: '回次',
  boxes: '岩芯箱',
  lithos: '岩性区间',
  qc: '质检结论',
};

const STATUS_TAG: Record<OutboxItem['status'], { color: string; text: string }> = {
  pending: { color: 'blue', text: '待同步' },
  failed: { color: 'red', text: '送交失败' },
  synced: { color: 'green', text: '已对上' },
};

const DECISION_TEXT: Record<NonNullable<Mismatch['decision']>, { color: string; text: string }> = {
  field: { color: 'orange', text: '以现场端为准' },
  catalog: { color: 'purple', text: '以编录室为准' },
  agree: { color: 'green', text: '双方一致' },
};

export default function Reconcile() {
  const { message } = AntApp.useApp();
  const side = useSideStore((s) => s.side);

  const [counts, setCounts] = useState<OutboxCounts>({ pending: 0, failed: 0, synced: 0 });
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [mismatches, setMismatches] = useState<Mismatch[]>([]);
  const [lastSync, setLastSync] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [simulateFail, setSimulateFail] = useState(false);
  const [adjudging, setAdjudging] = useState<Mismatch | null>(null);
  const [decision, setDecision] = useState<NonNullable<Mismatch['decision']>>('agree');
  const [note, setNote] = useState('');

  const loadData = useCallback(async () => {
    const [c, list, mm, ls] = await Promise.all([
      outboxCounts(side),
      outboxItems(side),
      computeMismatches(),
      lastSyncAt(side),
    ]);
    setCounts(c);
    setItems(list);
    setMismatches(mm);
    setLastSync(ls);
  }, [side]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSync = useCallback(async () => {
    setLoading(true);
    try {
      const result = await syncSide(side, { simulateFail });
      if (result.failed > 0) {
        message.warning(`送交完成：成功 ${result.pushed} 条，失败 ${result.failed} 条已留本机待重试`);
      } else if (result.pushed > 0) {
        message.success(`已同步 ${result.pushed} 条到对端，${result.skipped} 条已对上未重复挂`);
      } else {
        message.info('没有待同步的改动');
      }
      await loadData();
    } catch (e) {
      message.error(`同步失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [side, simulateFail, loadData, message]);

  const handleRetry = useCallback(async () => {
    setLoading(true);
    try {
      const result = await retryFailed(side, { simulateFail });
      if (result.failed > 0) {
        message.warning(`仍有 ${result.failed} 条失败，继续留在本机待重试`);
      } else {
        message.success(`失败项已重发成功（${result.pushed} 条）`);
      }
      await loadData();
    } finally {
      setLoading(false);
    }
  }, [side, simulateFail, loadData, message]);

  const openAdjudge = (m: Mismatch) => {
    setAdjudging(m);
    setDecision(m.decision ?? 'agree');
    setNote(m.note ?? '');
  };

  const submitAdjudge = async () => {
    if (!adjudging) return;
    await resolveMismatch(adjudging, decision, note, SIDE_SHORT[side]);
    message.success('已记录裁定，不影响其他段');
    setAdjudging(null);
    await loadData();
  };

  const pendingMismatches = mismatches.filter((m) => m.status !== 'resolved');
  const resolvedMismatches = mismatches.filter((m) => m.status === 'resolved');

  const outboxColumns: TableColumnsType<OutboxItem> = [
    { title: '实体', dataIndex: 'entity', width: 110, render: (v: OutboxItem['entity']) => ENTITY_TEXT[v] },
    { title: '操作', dataIndex: 'op', width: 80, render: (v: string) => (v === 'delete' ? '删除' : '新增/更新') },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (v: OutboxItem['status']) => <Tag color={STATUS_TAG[v].color}>{STATUS_TAG[v].text}</Tag>,
    },
    { title: '送交次数', dataIndex: 'attempts', width: 90, align: 'right' },
    { title: '产生时间', dataIndex: 'createdAt', width: 170, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
    {
      title: '失败原因',
      dataIndex: 'lastError',
      ellipsis: true,
      render: (v?: string) => (v ? <Text type="danger">{v}</Text> : '-'),
    },
  ];

  const mismatchColumns: TableColumnsType<Mismatch> = [
    { title: '孔号', dataIndex: 'holeNo', width: 110, render: (v: string) => <Text strong>{v}</Text> },
    { title: '深度区间(m)', width: 140, render: (_, row) => <Text strong>{`${row.depthFrom}~${row.depthTo}`}</Text> },
    {
      title: '类型',
      dataIndex: 'type',
      width: 120,
      render: (v: Mismatch['type']) => <Tag color="volcano">{MISMATCH_TYPE_TEXT[v]}</Tag>,
    },
    {
      title: '现场端（钻机班组）',
      width: 260,
      render: (_, row) => (
        <div>
          <div style={{ fontSize: 12, color: '#6b7a86' }}>{row.fieldLabel}</div>
          <Text>{row.fieldValue}</Text>
        </div>
      ),
    },
    {
      title: '编录室端（地质编录员）',
      width: 260,
      render: (_, row) => (
        <div>
          <div style={{ fontSize: 12, color: '#6b7a86' }}>{row.catalogLabel}</div>
          <Text>{row.catalogValue}</Text>
        </div>
      ),
    },
    {
      title: '状态',
      width: 130,
      render: (_, row) =>
        row.status === 'resolved' ? (
          <Tag color={DECISION_TEXT[row.decision ?? 'agree'].color} icon={<CheckCircleOutlined />}>
            {DECISION_TEXT[row.decision ?? 'agree'].text}
          </Tag>
        ) : (
          <Badge status="warning" text="待裁定" />
        ),
    },
    {
      title: '操作',
      width: 160,
      fixed: 'right',
      render: (_, row) =>
        row.status === 'resolved' ? (
          <Button size="small" type="link" onClick={async () => { await reopenMismatch(row.id); await loadData(); }}>
            撤销裁定
          </Button>
        ) : (
          <Button size="small" type="primary" onClick={() => openAdjudge(row)}>
            裁定
          </Button>
        ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        对账同步
      </Title>
      <Paragraph type="secondary">
        现场端与编录室端各持一份：改动只落自己这边，回到驻地再同步。送交失败留在本机按本侧重试，已对上的不重复挂；两边对不上的按孔 + 深度摆出来等人裁定，不挡别的段。
      </Paragraph>

      {/* 同步控制 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col xs={24} md={6}>
            <Statistic title="当前端别" value={SIDE_SHORT[side]} />
            <Text type="secondary" style={{ fontSize: 12 }}>{SIDE_LABEL[side]}</Text>
          </Col>
          <Col xs={8} md={4}>
            <Statistic title="待同步" value={counts.pending} valueStyle={{ color: '#1677ff' }} />
          </Col>
          <Col xs={8} md={4}>
            <Statistic title="送交失败" value={counts.failed} valueStyle={{ color: '#cf1322' }} />
          </Col>
          <Col xs={8} md={4}>
            <Statistic title="已对上" value={counts.synced} valueStyle={{ color: '#389e0d' }} />
          </Col>
          <Col xs={24} md={6} style={{ textAlign: 'right' }}>
            <Space wrap>
              <Button icon={<ReloadOutlined />} onClick={loadData}>
                刷新
              </Button>
              <Button
                type="primary"
                icon={<CloudSyncOutlined />}
                loading={loading}
                onClick={handleSync}
              >
                回到驻地同步
              </Button>
              <Button danger icon={<SendOutlined />} loading={loading} onClick={handleRetry} disabled={counts.failed === 0}>
                重试失败项
              </Button>
            </Space>
            <div style={{ marginTop: 8 }}>
              <Space size={6}>
                <Switch size="small" checked={simulateFail} onChange={setSimulateFail} />
                <Text type="secondary" style={{ fontSize: 12 }}>模拟送交失败（弱网，用于演示留本机重试）</Text>
              </Space>
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: '#8a99a5' }}>
              上次同步：{lastSync ? new Date(lastSync).toLocaleString('zh-CN') : '尚未同步'}
            </div>
          </Col>
        </Row>
      </Card>

      {counts.failed > 0 ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="error"
          showIcon
          message={`有 ${counts.failed} 条送交失败，已留在本机（${SIDE_SHORT[side]}）待重试，不影响其他段录入`}
          description="失败项不会丢失、不会重复挂；网络恢复后点「重试失败项」即可，已对上的不会重发。"
        />
      ) : null}

      {/* 发件箱 */}
      <Card size="small" title="本侧发件箱" style={{ marginBottom: 16 }}>
        {items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待送交改动；在归属端录入回次/岩芯箱/岩性区间后会挂到这里" />
        ) : (
          <Table
            rowKey="key"
            size="small"
            columns={outboxColumns}
            dataSource={items}
            pagination={{ pageSize: 6 }}
            scroll={{ x: 760 }}
          />
        )}
      </Card>

      {/* 对账不一致 */}
      <Card
        size="small"
        title={`两边对账不一致（${pendingMismatches.length} 待裁定 / ${mismatches.length} 总计）`}
        extra={<Tag color="blue">按孔 · 深度摆出，不阻塞其他段</Tag>}
      >
        {mismatches.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="两边数据对得上，暂无不一致" />
        ) : (
          <Table
            rowKey="id"
            size="small"
            columns={mismatchColumns}
            dataSource={mismatches}
            pagination={{ pageSize: 8 }}
            scroll={{ x: 1180 }}
            rowClassName={(row) => (row.status === 'resolved' ? 'mismatch-resolved' : '')}
            expandable={{
              expandedRowRender: (row) =>
                row.status === 'resolved' ? (
                  <Descriptions size="small" column={2}>
                    <Descriptions.Item label="裁定结论">
                      <Tag color={DECISION_TEXT[row.decision ?? 'agree'].color}>{DECISION_TEXT[row.decision ?? 'agree'].text}</Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="裁定人 / 时间">
                      {row.resolvedBy ?? '-'} · {row.resolvedAt ? new Date(row.resolvedAt).toLocaleString('zh-CN') : '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="裁定说明" span={2}>
                      {row.note ?? '-'}
                    </Descriptions.Item>
                  </Descriptions>
                ) : (
                  <Timeline
                    items={[
                      { color: 'blue', children: `${row.fieldLabel} — ${row.fieldValue}` },
                      { color: 'purple', children: `${row.catalogLabel} — ${row.catalogValue}` },
                    ]}
                  />
                ),
            }}
          />
        )}
      </Card>

      <Modal
        open={!!adjudging}
        title="裁定不一致"
        onCancel={() => setAdjudging(null)}
        onOk={submitAdjudge}
        okText="记录裁定"
        cancelText="取消"
      >
        {adjudging ? (
          <div>
            <Alert
              style={{ marginBottom: 12 }}
              type="warning"
              showIcon
              message={`${adjudging.holeNo} · ${adjudging.depthFrom}~${adjudging.depthTo}m · ${MISMATCH_TYPE_TEXT[adjudging.type]}`}
            />
            <Radio.Group
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
              optionType="button"
              buttonStyle="solid"
              style={{ marginBottom: 12 }}
            >
              <Radio.Button value="field">以现场端为准</Radio.Button>
              <Radio.Button value="catalog">以编录室为准</Radio.Button>
              <Radio.Button value="agree">双方一致</Radio.Button>
            </Radio.Group>
            <Input.TextArea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="裁定说明（可选）：如深度以现场回次为准、编录室重新核实等"
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
