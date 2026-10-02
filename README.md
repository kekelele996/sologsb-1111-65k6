# 矿区钻孔岩芯编目台（gbdrillcore）

面向地质勘查钻探班组与地质编录员：登记钻孔台帐、回次进尺与采取率、岩芯箱箱位，并按深度区间编录岩性描述与样品。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

**现场端（钻机班组）与编录室端（地质编录员）各持一份**：班组管回次进尺、采取率与岩芯箱装箱，编录室管岩性区间、样品号与质检结论；任一侧改动只落在自己这边，不互相覆盖。断网期间现场端照旧能录，回到驻地再同步；两边对账对不上的按孔 + 深度摆出来等人裁定，不挡别的段；送交失败留在本机按本侧重试，已对上的不重复挂。

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

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | Ant Design 5 + @ant-design/icons |
| 路由 | React Router 6（5 条业务路由 + 404） |
| 状态 | Zustand（holeStore / runStore / boxStore / lithoStore / qcStore + sideStore） |
| 存储 | IndexedDB（Dexie，库名 `gbdrillcore-db`，v3：两端各持一份 + 发件箱 + 对账裁定） |
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
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # drill-hole / drill-run / core-box / litho-log / qc
│       ├── stores/            # holeStore / runStore / boxStore / lithoStore / qcStore + sideStore
│       ├── components/common/ # DepthRangeInput / RecoveryBadge / BoxGrid / LithoColumn / StatBadge / FilterBar / EmptyPanel / ReplicaBanner
│       ├── hooks/             # useHoleFilter / useDepthCalc / useSide
│       ├── pages/             # HoleBoard / HoleList / RunLog / CoreBoxList / LithoEditor / QcList / Reconcile
│       ├── router/index.tsx   # 路由表
│       └── utils/             # recovery.ts / db.ts / export.ts / ownership.ts / syncEngine.ts / reconcile.ts（+ seed.ts / id.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 工作台 | 钻孔进度、设计达成率、未达设计待补勘清单、采取率异常清单（<75% 标红） |
| `/holes` | 钻孔台帐 | 建孔、坐标与孔口标高、设计/终孔深度、测斜数据、回次深度覆盖与岩芯箱数回显 |
| `/runs` | 回次记录 | 起止深度自动算进尺与采取率，低于 75% 立即标红并入异常清单（现场端持有） |
| `/boxes` | 岩芯箱编目 | 格位网格按深度填充、破损格标记、装箱深度连续性与格位容量校验（现场端持有） |
| `/lithology` | 岩性编录 | 按深度区间编录岩性/蚀变/矿化/RQD/样品，区间重叠报冲突并高亮，SVG 岩性柱状图（编录室端持有） |
| `/qc` | 质检结论 | 按深度区间对采取率/编录深度/样品代表性等下质检结论（编录室端持有） |
| `/reconcile` | 对账同步 | 本侧发件箱同步、失败留本机重试、两边不一致按孔+深度摆出并裁定，不阻塞其他段 |

## 两端各持一份与同步机制

- **端别**：顶栏「现场端 / 编录室端」切换（持久化到本机）。现场端=钻机班组，持有回次 `runs`、岩芯箱 `boxes`；编录室端=地质编录员，持有岩性区间 `lithos`、质检结论 `qc`；钻孔台帐 `holes` 为双方共享参考。
- **只读副本**：非归属方看到的是同步到达的只读副本（`runsReplica` / `boxesReplica` / `lithosReplica` / `qcReplica`），页面顶部有「对方数据只读副本」提示，编辑按钮禁用——班组补记回次不会带走编录室定的岩性区间，编录室改深度也不会冲掉现场端的采取率。
- **断网可录**：改动先落本侧主表并挂到本侧发件箱 `outbox`，不依赖网络。回到驻地在「对账同步」点「同步」送交对端。
- **失败重试**：送交失败的项留在本机（状态 `failed`，记录失败原因与次数），不丢、不阻塞其他段；网络恢复后点「重试失败项」。已对上（`synced`）的不重复挂。页面提供「模拟送交失败（弱网）」开关用于演示。
- **对账裁定**：`computeMismatches` 按孔 + 深度摆出现场端（回次/岩芯箱/终孔）与编录室端（岩性区间）对不上的地方：深度不一致、有回次无编录、有编录无回次、岩芯箱断档、终孔深度不一致。每条可独立裁定（以现场端为准 / 以编录室为准 / 双方一致），结论持久化到 `reconcile` 表，不改动双方业务数据、不影响其他段。
- **首次迁移**：第一次打开（无 `ownershipEnabled` 标记）时，`enableSides()` 把库里已有主表数据复制一份到对端只读副本，两端启用后都能看到对方的数据，之后改动只走发件箱同步、不再全量覆盖。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbdrillcore-db`）。主表：`holes`、`runs`、`boxes`、`lithos`、`qc`；对端只读副本：`runsReplica`、`boxesReplica`、`lithosReplica`、`qcReplica`；发件箱 `outbox`；对账裁定 `reconcile`；同步状态 `syncMeta`；元信息 `meta`。
- `db.version(3)` 新增质检表、对端副本表、发件箱与同步状态表；首次打开由 `enableSides()` 按归属把已有数据复制到对端副本。升级前可用顶栏「导出备份」导出全量 JSON（含 `qc`）。
- 首次打开且表为空时写入一批示例编目数据（`src/utils/seed.ts`，5 个钻孔 + 回次 + 岩芯箱 + 岩性区间 + 质检结论）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
