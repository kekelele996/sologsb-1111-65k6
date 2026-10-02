import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import DepthRangeInput from '../components/common/DepthRangeInput';
import EmptyPanel from '../components/common/EmptyPanel';
import { useHoleStore } from '../stores/holeStore';
import { useRunStore } from '../stores/runStore';
import { useQcStore } from '../stores/qcStore';
import { QC_CONCLUSIONS, type QualityConclusion, type QcConclusionType } from '../types/quality-control';
import { validateRange } from '../utils/recovery';
import { activeSide } from '../utils/db';

const { Title, Paragraph, Text } = Typography;

interface QcFormValues {
  holeId: string;
  fromDepth: number;
  toDepth: number;
  conclusion: QcConclusionType;
  sampleNo: string;
  inspector: string;
  checkedAt: Dayjs;
  remark?: string;
}

const conclusionColor: Record<QcConclusionType, string> = {
  通过: 'green',
  返工核实: 'orange',
  异常待裁定: 'red',
};

/** 编录室端：岩性、样品号对应的质检结论 */
export default function QualityReview() {
  const { message } = AntApp.useApp();
  const holes = useHoleStore((s) => s.holes);
  const currentHoleId = useHoleStore((s) => s.currentHoleId);
  const setCurrentHole = useHoleStore((s) => s.setCurrentHole);
  const runs = useRunStore((s) => s.runs);
  const qcs = useQcStore((s) => s.qcs);
  const addQc = useQcStore((s) => s.addQc);
  const updateQc = useQcStore((s) => s.updateQc);
  const removeQc = useQcStore((s) => s.removeQc);

  const [form] = Form.useForm<QcFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<QualityConclusion | null>(null);
  const [range, setRange] = useState({ from: 0, to: 0 });

  const activeHoleId = currentHoleId || holes[0]?.id || '';
  const canEdit = activeSide === 'office';
  const holeOptions = holes.map((hole) => ({ label: `${hole.holeNo} · 设计 ${hole.designDepth}m`, value: hole.id }));
  const holeQcs = useMemo(
    () => qcs.filter((qc) => qc.holeId === activeHoleId).sort((a, b) => a.fromDepth - b.fromDepth),
    [qcs, activeHoleId],
  );

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    const lastTo = holeQcs.reduce((max, qc) => Math.max(max, qc.toDepth), 0);
    setRange({ from: lastTo, to: Number((lastTo + 10).toFixed(2)) });
    form.setFieldsValue({
      holeId: activeHoleId,
      fromDepth: lastTo,
      toDepth: Number((lastTo + 10).toFixed(2)),
      conclusion: '通过',
      sampleNo: '',
      inspector: '陈立',
      checkedAt: dayjs(),
    } as unknown as QcFormValues);
    setOpen(true);
  };

  const openEdit = (record: QualityConclusion) => {
    setEditing(record);
    setRange({ from: record.fromDepth, to: record.toDepth });
    form.setFieldsValue({
      holeId: record.holeId,
      fromDepth: record.fromDepth,
      toDepth: record.toDepth,
      conclusion: record.conclusion,
      sampleNo: record.sampleNo,
      inspector: record.inspector,
      checkedAt: dayjs(record.checkedAt),
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
      conclusion: values.conclusion,
      sampleNo: values.sampleNo,
      inspector: values.inspector,
      checkedAt: values.checkedAt.toISOString(),
      remark: values.remark,
    };
    if (editing) {
      await updateQc(editing.id, payload);
      message.success(`已更新质检结论 ${payload.fromDepth}~${payload.toDepth}m`);
    } else {
      await addQc(payload);
      message.success('已保存质检结论');
    }
    setOpen(false);
  };

  const columns: TableColumnsType<QualityConclusion> = [
    { title: '深度区间(m)', width: 140, render: (_, row) => <Text strong>{row.fromDepth}~{row.toDepth}</Text> },
    { title: '样品号', dataIndex: 'sampleNo', width: 150, render: (v: string) => v || '-' },
    { title: '结论', dataIndex: 'conclusion', width: 130, render: (v: QcConclusionType) => <Tag color={conclusionColor[v]}>{v}</Tag> },
    { title: '检查日期', dataIndex: 'checkedAt', width: 120, render: (v: string) => dayjs(v).format('YYYY-MM-DD') },
    { title: '检查人', dataIndex: 'inspector', width: 100 },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v?: string) => v ?? '-' },
    {
      title: '操作',
      width: 140,
      render: (_, record) => canEdit ? (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title="确认删除该质检结论？" onConfirm={() => removeQc(record.id).then(() => message.success('已删除'))}>
            <Button size="small" type="link" danger>删除</Button>
          </Popconfirm>
        </Space>
      ) : (
        <Text type="secondary">编录室维护</Text>
      ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>质检结论</Title>
      <Paragraph type="secondary">质检结论只由编录室端维护；按孔和深度挂接样品号、结论与复核意见，现场端改动不会冲掉这些内容。</Paragraph>
      {!canEdit ? <Alert style={{ marginBottom: 12 }} type="info" showIcon message="当前为现场端：质检结论由编录室端维护，此处仅显示同步副本。" /> : null}
      <Space style={{ marginBottom: 12 }} wrap>
        <span style={{ color: '#6b7a86' }}>当前钻孔</span>
        <Select style={{ width: 220 }} value={activeHoleId} onChange={setCurrentHole} options={holeOptions} />
        <Button type="primary" onClick={openCreate} disabled={!activeHoleId || !canEdit}>新增质检结论</Button>
        {!canEdit ? <Tag color="blue">现场端只读</Tag> : null}
      </Space>
      {holeQcs.length === 0 ? (
        <EmptyPanel description="该孔暂无质检结论" actionText="新增质检结论" onAction={openCreate} />
      ) : (
        <Card size="small">
          <Table rowKey="id" size="small" columns={columns} dataSource={holeQcs} pagination={{ pageSize: 10 }} scroll={{ x: 950 }} />
        </Card>
      )}

      <Modal open={open} title={editing ? '编辑质检结论' : '新增质检结论'} onCancel={() => setOpen(false)} onOk={submit} width={640}>
        <Form form={form} layout="vertical">
          <Form.Item name="holeId" label="钻孔" rules={[{ required: true, message: '请选择钻孔' }]}>
            <Select options={holeOptions} />
          </Form.Item>
          <Form.Item label="深度区间" required>
            <DepthRangeInput
              fromDepth={range.from}
              toDepth={range.to}
              referenceRuns={runs.filter((run) => run.holeId === (Form.useWatch('holeId', form) ?? activeHoleId))}
              maxDepth={holes.find((hole) => hole.id === (Form.useWatch('holeId', form) ?? activeHoleId))?.designDepth}
              onChange={(patch) => {
                setRange((prev) => ({ ...prev, ...patch }));
                form.setFieldsValue(patch as unknown as QcFormValues);
              }}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="conclusion" label="结论" rules={[{ required: true }]}>
              <Select style={{ width: 150 }} options={QC_CONCLUSIONS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="sampleNo" label="样品号">
              <Input style={{ width: 180 }} placeholder="如：YP-2406-01" />
            </Form.Item>
            <Form.Item name="inspector" label="检查人" rules={[{ required: true, message: '请输入检查人' }]}>
              <Input style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="checkedAt" label="检查日期" rules={[{ required: true, message: '请选择日期' }]}>
              <DatePicker style={{ width: 160 }} />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="复核意见">
            <Input.TextArea rows={3} placeholder="需要现场补核或裁定的说明" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
