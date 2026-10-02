# 矿区钻孔岩芯编目台（gbdrillcore）

面向地质勘查钻探班组与地质编录员的本地优先单页应用。现场钻机班组与编录室地质编录员各持一份独立数据：现场端负责回次进尺、采取率、岩芯箱装箱；编录室端负责岩性区间、样品号、质检结论。任一端改动只落在本侧业务表和送交队列，回到驻地后再同步对账。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21811>

停止并清理：

```bash
docker compose down
```

## 端别与数据归属

顶栏可切换「钻机班组（现场端）」和「编录室」。切换后刷新页面并打开独立 IndexedDB：

| 端别 | 可维护数据 | 对端数据 |
| --- | --- | --- |
| 现场端 `gbdrillcore-field-db` | 钻孔主档、回次进尺/采取率、岩芯箱装箱 | 岩性、样品号、质检结论为只读同步副本 |
| 编录室端 `gbdrillcore-office-db` | 岩性区间、样品号、质检结论 | 钻孔、回次、岩芯箱为只读同步副本 |

所有业务记录带 `ownerSide`、`revision`、`updatedAt`。只有归属端可以编辑本侧记录；对端同步过来的数据只作查看、柱状图、连续性校验和对账使用。

## 断网录入、送交重试与幂等

- 断网时所有本侧录入照常写入本机 IndexedDB，并进入本侧 `outbox`。
- 回到驻地后，在「同步对账」页：
  - 同一浏览器演示/驻地交换：点「驻地支点重试/直连」，直接送交另一个端别库；
  - 两台设备：现场/编录室导出本侧同步包（JSON），由对端导入；对端会生成回执 JSON，发送端再导入回执消单。
- `pending` / `failed` 挂单保留在本机并按本侧重试；`delivered` 不重复导出、不重复挂。
- 接收端维护 `syncState`，按实体记录已应用版本；重复导入旧包不会重复写或回退新数据。
- 单条坏数据只写入回执错误，不阻断同包其他孔深段。

## 深度对账与人工裁定

同步后按孔比较现场回次覆盖与编录室岩性/样品区间：

- 岩性或样品声称的深度段缺少现场回次时，生成具体深度冲突；
- 冲突只挂具体孔和深度段，其他已对上的数据继续同步、查看和使用；
- 待裁定项在「同步对账」页按孔深列出，可记录「按现场处理 / 按编录室处理 / 继续挂起」和裁定说明；
- 裁定不会擅改两侧原始记录；后续数据补齐后再次对账，未人工裁定的问题可自动关闭。

## 首次迁移

首次打开新版本时执行一次性准备：

1. 读取旧混合库 `gbdrillcore-db` 的 v1/v2 数据；旧库保留为迁移前备份。
2. 旧库已有数据时，按归属补 `ownerSide/revision/updatedAt`，并分别放入现场端库和编录室端库；对端得到只读基线，保证迁移后功能立即可用。
3. 旧库为空时，使用内置演示数据建立两端基线。
4. 基线迁移不生成 `outbox`，避免第一次启用时把已经对上的历史数据重复送交。
5. 完成后各端按自己的改动开始挂同步单。

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | Ant Design 5 + @ant-design/icons |
| 路由 | React Router 6（工作台、端别业务页、同步对账 + 404） |
| 状态 | Zustand（holeStore / runStore / boxStore / lithoStore / qcStore） |
| 存储 | IndexedDB（Dexie，现场端与编录室端各一库） |
| 同步 | 本机 outbox + 同步包/回执 + 版本幂等 + 深度冲突表 |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21811
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml
├── .env.example
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # 钻孔 / 回次 / 岩芯箱 / 岩性 / 质检 / 同步模型
│       ├── stores/            # 各业务 Zustand store，写本侧表并挂 outbox
│       ├── components/common/ # 深度输入、采取率徽章、箱格、岩性柱等
│       ├── hooks/             # useHoleFilter / useDepthCalc
│       ├── pages/             # 工作台、各业务页、质检结论、同步对账
│       ├── router/index.tsx
│       └── utils/
│           ├── db.ts                 # 端别库与旧混合库
│           ├── migration.ts          # 首次按归属迁移到两端
│           ├── syncEngine.ts         # 同步包、回执、幂等、深度对账
│           ├── syncData.ts           # 归属戳、版本、挂单
│           ├── recovery.ts
│           ├── seed.ts
│           ├── export.ts
│           └── id.ts
```

## 功能与路由

| 路由 | 端别 | 说明 |
| --- | --- | --- |
| `/` | 两端 | 钻孔进度、设计达成率、采取率异常清单（<75% 标红） |
| `/holes` | 现场维护 / 编录只读 | 建孔、坐标、孔口标高、设计/终孔深度、测斜与覆盖回显 |
| `/runs` | 现场端 | 回次起止深度、进尺、采取率 |
| `/boxes` | 现场端 | 岩芯箱格位、破损格、装箱连续性与容量校验 |
| `/lithology` | 编录室端 | 岩性、蚀变、矿化、RQD、样品号与岩性柱 |
| `/quality` | 编录室端 | 按孔深维护质检结论 |
| `/sync` | 两端 | outbox 重试、同步包/回执交换、深度冲突裁定 |

## 数据存储说明

- 容器无状态，不依赖数据库服务；数据保留在各设备浏览器 IndexedDB。
- 端别库表：`holes`、`runs`、`boxes`、`lithos`、`qcs`、`outbox`、`conflicts`、`syncState`、`meta`。
- 旧库 `gbdrillcore-db` 不删除，可作为升级前数据备份。顶栏「导出备份」导出当前端别库全量 JSON。
