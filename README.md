# 古树名木复壮养护档案（sologsb101-1015）

面向园林部门的古树名木保护岗：为一树一档建立检查、复壮、加固与长势复评的完整记录，
按检查周期自动提示加固件超期，长势为衰弱 / 濒危时强制填写后续措施。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22815**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbheritagetree` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3 | `<script setup>` 组合式 API |
| 语言 | TypeScript 5 | `strict` 模式，`vue-tsc --noEmit` 零错误 |
| UI 组件库 | Element Plus 2 | 表格、表单、弹窗、日期选择、时间线、消息提示 |
| 图标 | @element-plus/icons-vue | 入口统一全局注册 |
| 构建 | Vite 6 | 开发端口与宿主端口一致（22815） |
| 路由 | Vue Router 4 | `createWebHistory` + 路由懒加载 |
| 状态管理 | Pinia 2 | setup store，跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbheritagetree`，含 v1 → v2 → v3 升级迁移 |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1015/
├── README.md
├── docker-compose.yml          # name: gbheritagetree，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 入口：Pinia + Router + Element Plus + 初始化数据库
        ├── App.vue             # 外壳：顶部导航 + 当前古树上下文 + 页脚
        ├── env.d.ts
        ├── styles/main.css
        ├── types/              # tree.ts survey.ts measure.ts support.ts review.ts transfer.ts
        ├── stores/             # treeStore.ts measureStore.ts reviewStore.ts transferStore.ts
        ├── components/common/  # VigorTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useTreeHistory.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面（含管护责任移交 TransferBoard）
        ├── router/index.ts     # 路由表 + ROUTES 常量
        └── utils/              # dimension.ts db.ts export.ts seed.ts id.ts attribution.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/trees` | `pages/TreeList.vue` | 古树一树一档：新建/编辑/级联删除、按保护级别与树种筛选、回显检查次数与最新长势等级 |
| `/trees/:id/surveys` | `pages/TreeSurvey.vue` | 树体与立地检查：录树高/胸径/冠幅/倾斜/空洞并对比上次、年化生长量、古树历史时间线 |
| `/measures` | `pages/MeasureBoard.vue` | 复壮措施台账：按类型与实施状态筛选、行内草稿、批量改状态，完成即回写最近复壮日期 |
| `/supports` | `pages/SupportBoard.vue` | 支撑加固与避雷件登记：超周期未检查自动高亮 + 顶部提醒 + 一键登记本次检查 |
| `/reviews` | `pages/ReviewView.vue` | 长势复评与结构版本：衰弱/濒危强制填写后续措施、历史时间线、JSON 导入导出、复评结论当时归属 |
| `/transfers` | `pages/TransferBoard.vue` | 管护责任移交：建移交清册、两侧各留一份、按古树编号逐株对账、对不上先挂起、单侧出错只重试本侧 |

`/` 重定向到 `/trees`，未匹配路径统一回落到 `/trees`。
**层级路由支持直接深链**：把 `http://localhost:22815/trees/tree-guozijian-0007/surveys` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「古树档案不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbheritagetree`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`，`version(1)` 建立全部表，`version(2)` 补齐索引并执行 `.upgrade()` 迁移，
  `version(3)` 新增管护移交表并为古树补归属履历：
  * `surveys` 增加 `[treeId+date]` 复合索引、`measures` 增加 `operator` 索引、`supports` 增加 `lastCheckDate` 索引、`reviews` 增加 `trend` 索引；
  * 回填 `revision` / `createdAt` / `updatedAt`；
  * 为 `trees` 补齐 `lastMeasureDate`（最近复壮日期）回写字段；
  * 为 `reviews` 补齐 `followUp`（后续措施）字段；
  * 为 `supports` 补齐 `lastCheckDate` 与 `checkCycleMon` 缺省值；
  * 新增 `transfers` 管护移交表；**已有数据升级时按现有管护单位为每株古树补一段归属履历**（`ownershipHistory`，备注「历史数据升级补录」）。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `trees` | id | code, species, protectLevel, ageYears, createdAt, updatedAt, owner |
  | `surveys` | id | treeId, [treeId+date], date, siteNote |
  | `measures` | id | treeId, type, state, date, operator |
  | `supports` | id | treeId, type, installDate, lastCheckDate |
  | `reviews` | id | treeId, date, vigor, trend |
  | `transfers` | id | treeId, code, fromOwner, toOwner, handoverDate, status, reconcile |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `trees` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **古树 → 树体检查 / 复壮措施 / 加固件 / 长势复评** 三层互相引用：
  * 3 株古树（京-01-0007 国槐 一级 / 京-02-0113 银杏 一级 / 京-05-0246 侧柏 二级）；
  * 9 条树体检查（每株 3 次，树高胸径随日期递增）、8 条复壮措施（覆盖计划 / 实施中 / 已完成）、
    5 件加固件（其中 **京-01-0007 支撑杆** 与 **京-05-0246 避雷** 故意超周期未检查，用于验证高亮与提醒）、
    7 条长势复评（含衰弱 / 濒危样本且均已填写后续措施）。
  * 固定 id 如 `tree-guozijian-0007`、`tree-xiangshan-0113`、`tree-ritan-0246` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的古树 id」这一界面偏好，不存业务数据。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22815
```

其他命令：

```bash
npm run build        # vue-tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

* **倾斜安全阈值**：< 5° 正常；5°–10° 需关注；> 10° 超限（`src/utils/dimension.ts`）。
* **空洞风险**：1–2 处需关注，≥ 3 处判定为高风险，建议立即安排树洞修补与防腐处理。
* **生长量年化**：由最近两次检查的差值按实际天数折算为「每年」增量，间隔不足 30 天时退回直接差值。
* **加固件超期**：`最近检查日期 + 检查周期（月）` 早于今天即为超期，列表自动高亮并在顶部汇总提醒；
  「登记本次检查」会把最近检查日期置为今天并解除高亮。
* **复评强制校验**：长势为「衰弱」或「濒危」时，后续措施为必填项，未填写无法保存。
* **措施回写**：复壮措施状态改为「已完成」时，若实施日期晚于古树现有最近复壮日期，则自动回写该日期。
* **管护责任移交口径**（`src/utils/attribution.ts`、`/transfers`）：
  * 移交前**定稿的复评结论仍算原单位**；交接日（含）后的树体检查、复壮措施与加固件归新单位（加固件按安装日期）。
  * **台账按现在归属**统计管护株数（古树当前 `owner`）；**复评结论按当时归属**统计（沿移交链路按复评日期解析，支持 A→B→C 多次移交）。
  * 原单位档案室留一份移交清册、新单位留自己那份；两侧按**古树编号逐株对账**，对不上的先**挂起**等核对，核对一致后才能确认移交。
  * 移交确认时把古树当前管护单位切到新单位，并在 `ownershipHistory` **追加一段归属履历**（不覆盖历史）；已有数据升级时按现有管护单位补一段。
  * 某一侧清册留存出错时**只重试本侧**，不影响另一侧。
* 删除古树会**级联清理**其下的树体检查、复壮措施、加固件、复评与移交记录（同一 Dexie 事务内完成）。
