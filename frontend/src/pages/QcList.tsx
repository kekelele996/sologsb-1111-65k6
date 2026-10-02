import { useMemo, useState } from 'react';
import { App as AntApp, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import ReplicaBanner from '../components/common/ReplicaBanner';
import { useHoleStore } from '../stores/holeStore';
import { useQcStore } from '../stores/qcStore';
import { useCanEdit } from '../hooks/useSide';
import { QC_CONCLUSIONS, QC_ITEMS, type QcConclusion, type QcItem, type QcRecord } from '../types/qc';
import { validateRange } from '../utils/recovery';

const { Title, Paragraph, Text } = Typography;

interface QcFormValues {
  holeId: string;
  fromDepth: number;
  toDepth: number;
  item: QcItem;
  conclusion: QcConclusion;
  inspector: string;
  inspectedAt: Dayjs;
  remark?: string;
}

const CONCLUSION_COLOR: Record<QcConclusion, string> = {
  合格: 'green',
  不合格: 'red',
  待复检: 'orange',
};

/** 质检结论：编录室端维护；现场端只读同步副本 */
export default function QcList() {
  const { message } = AntApp.useApp();
  const holes = useHoleStore((s) => s.holes);
  const currentHoleId = useHoleStore((s) => s.currentHoleId);
  const setCurrentHole = useHoleStore((s) => s.setCurrentHole);
  const qcList = useQcStore((s) => s.qcList);
  const addQc = useQcStore((s) => s.addQc);
  const updateQc = useQcStore((s) => s.updateQc);
  const removeQc = useQcStore((s) => s.removeQc);
  const canEdit = useCanEdit('qc');

  const [form] = Form.useForm<QcFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<QcRecord | null>(null);
  const [range, setRange] = useState<{ from: number; to: number }>({ from: 0, to: 0 });

  const holeOptions = holes.map((hole) => ({ label: `${hole.holeNo} · ${hole.rigNo}`, value: hole.id }));
  const activeHoleId = currentHoleId || holes[0]?.id || '';
  const holeQc = useMemo(
    () => qcList.filter((q) => q.holeId === activeHoleId).sort((a, b) => a.fromDepth - b.fromDepth),
    [qcList, activeHoleId],
  );

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    const lastTo = holeQc.reduce((max, q) => Math.max(max, q.toDepth), 0);
    setRange({ from: Number(lastTo.toFixed(2)), to: Number((lastTo + 10).toFixed(2)) });
    form.setFieldsValue({
      holeId: activeHoleId,
      fromDepth: Number(lastTo.toFixed(2)),
      toDepth: Number((lastTo + 10).toFixed(2)),
      item: '岩芯采取率',
      conclusion: '待复检',
      inspector: '陈立',
      inspectedAt: dayjs(),
    } as unknown as QcFormValues);
    setOpen(true);
  };

  const openEdit = (record: QcRecord) => {
    setEditing(record);
    setRange({ from: record.fromDepth, to: record.toDepth });
    form.setFieldsValue({
      holeId: record.holeId,
      fromDepth: record.fromDepth,
      toDepth: record.toDepth,
      item: record.item,
      conclusion: record.conclusion,
      inspector: record.inspector,
      inspectedAt: dayjs(record.inspectedAt),
      remark: record.remark,
    } as unknown as QcFormValues);
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const rangeError = validateRange(range.from, range.to);
    if (rangeError) {
      message.error(rangeError);
      return;
    }
    const payload = {
      holeId: values.holeId,
      fromDepth: range.from,
      toDepth: range.to,
      item: values.item,
      conclusion: values.conclusion,
      inspector: values.inspector,
      inspectedAt: values.inspectedAt.toISOString(),
      remark: values.remark,
    };
    if (editing) {
      await updateQc(editing.id, payload);
      message.success(`已更新质检结论 ${payload.item}：${payload.conclusion}`);
    } else {
      await addQc(payload);
      message.success(`已新增质检结论 ${payload.item}：${payload.conclusion}`);
    }
    setOpen(false);
  };

  const columns: TableColumnsType<QcRecord> = [
    { title: '深度区间(m)', width: 140, render: (_, row) => <Text strong>{`${row.fromDepth}~${row.toDepth}`}</Text> },
    { title: '质检项', dataIndex: 'item', width: 130 },
    {
      title: '结论',
      dataIndex: 'conclusion',
      width: 110,
      render: (v: QcConclusion) => <Tag color={CONCLUSION_COLOR[v]}>{v}</Tag>,
    },
    { title: '质检人', dataIndex: 'inspector', width: 90 },
    { title: '质检日期', dataIndex: 'inspectedAt', width: 120, render: (v: string) => dayjs(v).format('YYYY-MM-DD') },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v?: string) => v ?? '-' },
    ...(canEdit
      ? [
          {
            title: '操作',
            width: 140,
            fixed: 'right' as const,
            render: (_: unknown, record: QcRecord) => (
              <Space size={2}>
                <Button size="small" type="link" onClick={() => openEdit(record)}>
                  编辑
                </Button>
                <Popconfirm title="确认删除该质检结论？" onConfirm={() => removeQc(record.id).then(() => message.success('已删除'))}>
                  <Button size="small" type="link" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        质检结论
      </Title>
      <Paragraph type="secondary">编录室端按深度区间对岩芯采取率、编录深度、样品代表性等下质检结论；现场端在此只读查看同步副本。</Paragraph>

      <ReplicaBanner entity="qc" />

      <Space style={{ marginBottom: 12 }} wrap>
        <span style={{ color: '#6b7a86' }}>当前钻孔</span>
        <Select style={{ width: 200 }} value={activeHoleId} onChange={setCurrentHole} options={holeOptions} placeholder="选择钻孔" />
        <Button type="primary" onClick={openCreate} disabled={!activeHoleId || !canEdit}>
          新增质检结论
        </Button>
        <Tag color="blue">{holeQc.length} 条</Tag>
      </Space>

      {holeQc.length === 0 ? (
        <EmptyPanel description="该孔暂无质检结论" actionText={canEdit ? '新增质检结论' : undefined} onAction={canEdit ? openCreate : undefined} />
      ) : (
        <Card size="small">
          <Table rowKey="id" size="small" columns={columns} dataSource={holeQc} pagination={{ pageSize: 8 }} scroll={{ x: 900 }} />
        </Card>
      )}

      <Modal open={open} title={editing ? '编辑质检结论' : '新增质检结论'} onCancel={() => setOpen(false)} onOk={submit} okText="保存" cancelText="取消" width={640}>
        <Form form={form} layout="vertical">
          <Form.Item name="holeId" label="钻孔" rules={[{ required: true, message: '请选择钻孔' }]}>
            <Select style={{ width: 220 }} options={holeOptions} />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item label="深度区间" required>
              <Space align="center">
                <InputNumber
                  min={0}
                  step={0.5}
                  value={range.from}
                  addonAfter="m"
                  style={{ width: 150 }}
                  onChange={(v) => {
                    const from = Number(v) || 0;
                    setRange((prev) => ({ ...prev, from }));
                    form.setFieldsValue({ fromDepth: from } as unknown as QcFormValues);
                  }}
                />
                <span>~</span>
                <InputNumber
                  min={0}
                  step={0.5}
                  value={range.to}
                  addonAfter="m"
                  style={{ width: 150 }}
                  onChange={(v) => {
                    const to = Number(v) || 0;
                    setRange((prev) => ({ ...prev, to }));
                    form.setFieldsValue({ toDepth: to } as unknown as QcFormValues);
                  }}
                />
              </Space>
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="item" label="质检项" rules={[{ required: true, message: '请选择质检项' }]}>
              <Select style={{ width: 160 }} options={QC_ITEMS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="conclusion" label="结论" rules={[{ required: true, message: '请选择结论' }]}>
              <Select style={{ width: 140 }} options={QC_CONCLUSIONS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="inspector" label="质检人" rules={[{ required: true, message: '请输入质检人' }]}>
              <Input style={{ width: 130 }} maxLength={16} placeholder="质检人" />
            </Form.Item>
            <Form.Item name="inspectedAt" label="质检日期" rules={[{ required: true, message: '请选择质检日期' }]}>
              <DatePicker style={{ width: 160 }} />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="复检说明等" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
