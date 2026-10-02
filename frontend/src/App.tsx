import { useEffect, useState } from 'react';
import { Layout, Menu, Spin, Tag, Typography, App as AntApp, Button, Space } from 'antd';
import {
  CompassOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  ProfileOutlined,
  SafetyCertificateOutlined,
  BarsOutlined,
  SyncOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { downloadText, exportBackupJson } from './utils/export';
import { useHoleStore } from './stores/holeStore';
import { useRunStore } from './stores/runStore';
import { useBoxStore } from './stores/boxStore';
import { useLithoStore } from './stores/lithoStore';
import { useQcStore } from './stores/qcStore';
import { activeSide } from './utils/db';
import { prepareWorkstationData } from './utils/migration';
import { setActiveSide } from './utils/workstationSide';
import { SIDE_LABEL, type WorkstationSide } from './types/sync';
import { deliverDirectly } from './utils/syncEngine';

const { Header, Sider, Content, Footer } = Layout;
const { Title, Text } = Typography;

const MENU_ITEMS = [
  { key: '/', icon: <CompassOutlined />, label: <Link to="/">工作台</Link>, sides: ['field', 'office'] },
  { key: '/holes', icon: <DatabaseOutlined />, label: <Link to="/holes">钻孔台帐</Link>, sides: ['field', 'office'] },
  { key: '/runs', icon: <BarsOutlined />, label: <Link to="/runs">回次记录</Link>, sides: ['field'] },
  { key: '/boxes', icon: <ProfileOutlined />, label: <Link to="/boxes">岩芯箱</Link>, sides: ['field'] },
  { key: '/lithology', icon: <ExperimentOutlined />, label: <Link to="/lithology">岩性编录</Link>, sides: ['office'] },
  { key: '/quality', icon: <SafetyCertificateOutlined />, label: <Link to="/quality">质检结论</Link>, sides: ['office'] },
  { key: '/sync', icon: <SyncOutlined />, label: <Link to="/sync">同步对账</Link>, sides: ['field', 'office'] },
];

/** 应用外壳：左侧导航 + 顶部导出备份，负责一次性的本地数据装载 */
export default function App() {
  const { message } = AntApp.useApp();
  const [ready, setReady] = useState(false);
  const hydrateHoles = useHoleStore((s) => s.hydrate);
  const hydrateRuns = useRunStore((s) => s.hydrate);
  const hydrateBoxes = useBoxStore((s) => s.hydrate);
  const hydrateLithos = useLithoStore((s) => s.hydrate);
  const hydrateQcs = useQcStore((s) => s.hydrate);
  const location = useLocation();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await prepareWorkstationData();
        await Promise.all([hydrateHoles(), hydrateRuns(), hydrateBoxes(), hydrateLithos(), hydrateQcs()]);
      } catch (error) {
        message.error(`本地数据装载失败：${(error as Error).message}`);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [hydrateHoles, hydrateRuns, hydrateBoxes, hydrateLithos, hydrateQcs, message]);

  const selectedKey =
    MENU_ITEMS.map((item) => item.key)
      .filter((key) => (key === '/' ? location.pathname === '/' : location.pathname.startsWith(key)))
      .sort((a, b) => b.length - a.length)[0] ?? '/';

  const menuItems = MENU_ITEMS.filter((item) => item.sides.includes(activeSide));

  const switchSide = (side: WorkstationSide) => {
    if (side === activeSide) return;
    setActiveSide(side);
    window.location.reload();
  };

  const quickSync = async () => {
    const result = await deliverDirectly(activeSide);
    if (result.ack.errors.length) {
      message.warning(`同步完成：${result.ack.appliedChangeIds.length} 条已对上，${result.ack.errors.length} 条留在本机重试`);
    } else if (result.ack.appliedChangeIds.length) {
      message.success(`已送交并对上 ${result.ack.appliedChangeIds.length} 条变更`);
    } else {
      message.info('没有待送交变更，已重新对账');
    }
    await Promise.all([hydrateHoles(), hydrateRuns(), hydrateBoxes(), hydrateLithos(), hydrateQcs()]);
  };

  const handleExport = async () => {
    const json = await exportBackupJson();
    downloadText(`gbdrillcore-backup-${new Date().toISOString().slice(0, 10)}.json`, json);
    message.success('已导出 IndexedDB 全量 JSON 备份');
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="0" width={204} style={{ background: '#2b3a46' }}>
        <div style={{ padding: '16px 16px 8px' }}>
          <Title level={5} style={{ color: '#fff', margin: 0 }}>
            钻孔岩芯编目台
          </Title>
          <Text style={{ color: '#9fb4c2', fontSize: 12 }}>gbdrillcore · 纯前端本地存储</Text>
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={menuItems} style={{ background: 'transparent' }} />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text strong>矿区钻孔岩芯编目台</Text>
          <Space>
            <Tag color={activeSide === 'field' ? 'blue' : 'purple'} icon={<UserSwitchOutlined />}>
              {SIDE_LABEL[activeSide]}
            </Tag>
            <Button.Group>
              <Button size="small" type={activeSide === 'field' ? 'primary' : 'default'} onClick={() => switchSide('field')}>
                钻机班组
              </Button>
              <Button size="small" type={activeSide === 'office' ? 'primary' : 'default'} onClick={() => switchSide('office')}>
                编录室
              </Button>
            </Button.Group>
            <Button icon={<SyncOutlined />} onClick={quickSync}>
              驻地直连同步
            </Button>
            <Button icon={<DownloadOutlined />} onClick={handleExport}>
              导出备份
            </Button>
          </Space>
        </Header>
        <Content style={{ padding: 16 }}>
          {ready ? (
            <Outlet />
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
              <Spin size="large" />
            </div>
          )}
        </Content>
        <Footer style={{ textAlign: 'center', color: '#8a99a5', padding: '12px 0' }}>
          {SIDE_LABEL[activeSide]}数据独立保存在浏览器 IndexedDB；断网可录，回驻地后按端别同步对账
        </Footer>
      </Layout>
    </Layout>
  );
}
