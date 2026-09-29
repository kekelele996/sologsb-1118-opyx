# 考古探方地层编目台（gbtrenchlog）

面向考古发掘工地的记录员与整理人员，把「探方 → 地层单位 → 堆积描述 → 层位关系 → 出土物」整理成一套可核对的编目档案，解决地层编号重复、打破与叠压关系记不清、出土物脱离层位上下文的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21818>

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地）
```

`.env` 可调：

```
COMPOSE_PROJECT_NAME=gbtrenchlog
FRONTEND_PORT=21818
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（Composition API） |
| 语言 | TypeScript（`vue-tsc` 类型检查零错误） |
| UI 组件库 | Element Plus |
| 状态管理 | Zustand（`zustand/vanilla` createStore + Vue 响应式桥接） |
| 路由 | Vue Router 4（History 模式，nginx `try_files` 回落） |
| 构建 | Vite 6 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21818
npm run build      # 类型检查 + 生产构建
```

## 四、目录结构

```
sologsb-1118/
├── docker-compose.yml          # 顶层 name: gbtrenchlog，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # trench.ts / stratum.ts / artifact.ts / relation.ts / period.ts / index.ts
│       ├── stores/             # trenchStore / stratumStore / artifactStore / relationStore / periodStore（Zustand）
│       ├── components/common/  # StratumDepthBar / RelationGraph / TrenchTag / UnitPicker
│       ├── hooks/              # useStratumOrder / useRelationGraph / usePhasing / usePersistentStore
│       ├── pages/              # TrenchesPage / StrataPage / ArtifactsPage / RelationsPage / PhasingPage / SectionsPage
│       ├── router/index.ts
│       └── utils/              # graph.ts / phasing.ts / export.ts / id.ts
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Trench 探方 | 探方号、发掘区、规格、基点坐标、开口层位、发掘起止、负责人、四壁备注、是否回填 | `trenches` |
| Stratum 地层单位 | 单位号、类型（地层/灰坑/房址/沟/墓葬）、开口层位、上下界深度、土质土色、包含物、堆积成因、绘图拍照号 | `strata` |
| Artifact 出土物 | 所属地层单位、器物编号、类别、件数、残整程度、探方内 X/Y/Z、出土日期、提取人、临时存放 | `artifacts` |
| Relation 层位关系 | 单位 A、关系类型（叠压/打破/共存）、单位 B、判定依据、记录人、备注 | `relations` |
| Period 期别 | 期别名、由早到晚的排序序号、分期说明（项目共用一套期别序列） | `periods` |
| Assignment 分期指派 | 地层单位 → 期别（每个单位至多一期，空为未定） | `assignments` |

- 数据库名 `gbtrenchlog`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史地层单位补齐「开口层位」字段并规范包含物数组；
- `version(3)` 新增「期别 / 分期指派」两张表以支持跨探方联合分期，老库自动升级、历史数据无损；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/trenches` | 探方清单：按「发掘区-探方号」校验唯一性，卡片显示单位数、出土物件数、关系数与发掘进度状态 |
| `/strata` | 地层单位编目表：按探方/类型/期别/深度筛选，顶部按探方汇总各期单位数，期别列展示定一期结果，分期相抵整行标红 |
| `/artifacts` | 出土物登记与清单：先锁定所属地层单位（级联选择器），带出深度区间并校验出土深度是否在该区间内 |
| `/relations` | 层位关系视图：SVG 有向图展示叠压/打破，点击节点高亮直接关系，新增关系前做环路检测；可按期别联动只看某期单位，节点带期别角标 |
| `/phasing` | 跨探方联合分期：维护期别序列（由早到晚）、按探方给单位定一期，确认前沿全部关系链核验 |
| `/sections` | 四壁剖面示意：按深度刻度绘制地层条带与厚度标注，叠加出土物投影点；按期别联动时非该期单位以虚线残影保留层位上下文 |

## 七、校验规则

- 同一「发掘区-探方号」只允许一个探方；
- 同一探方内单位号不可重复（保存时拒绝）；
- 上界深度大于下界深度即为**层序倒置**，编目表整行标红并在顶部汇总；
- 若「A 叠压/打破 B」但 A 的上界深度大于 B，则提示层位关系与深度矛盾；
- 新增层位关系前做**环路检测**（DFS），会形成闭合矛盾的关系直接拒绝保存；
- 出土物的 Z（深度）必须落在其所属地层单位的深度区间内，否则给出层位核对提示。

### 跨探方联合分期核验

- 项目共用一套期别序列（order 越小年代越早），记录员在「联合分期」页按探方给每个单位统一定一期，未定单位不参与期别判断；
- 跨方/同方的叠压或打破关系要求**前项（A，堆积更晚）期别不早于后项（B，堆积更早）**，即 `order(A) ≥ order(B)`；**共存**表示同期，用并查集并为同期组，不产生时序方向；
- 保存或调整分期、点击「核验并确认」时，沿全部关系链（含跨探方）做两类核验：
  - **绕回**：叠压/打破关系自相闭合（含「共存又互相叠压/打破」的自环）；
  - **期别相抵**：关系链上前项期别反而早于后项（同一单位被排进前后颠倒的期别）；
- 任一矛盾都会**列出具体单位（带探方号）与完整关系路径（含每步关系类型）并挡住确认**，修改单位期别时行内即时给出「应为前/后项、不早/晚于某期」的边界提示；
- 新增层位关系后若冲抵已确认的分期，会弹窗提示前往联合分期调整；
- 确认结果写入 IndexedDB，刷新或重开浏览器后保留；删除期别会把该期单位改回未定，删除单位会清理其指派；
- 编目表可按探方查看各期单位数、按期别筛选；关系图与四壁剖面随所选期别联动，剖面图中被筛掉的单位以虚线残影保留层位上下文。
