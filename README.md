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
        ├── types/              # tree.ts survey.ts measure.ts support.ts review.ts ownership.ts handover.ts
        ├── stores/             # treeStore.ts measureStore.ts reviewStore.ts handoverStore.ts
        ├── components/common/  # VigorTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useTreeHistory.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面（含 HandoverBoard.vue 管护责任移交）
        ├── router/index.ts     # 路由表 + ROUTES 常量
        ├── scripts/            # test-handover.mjs 领域规则测试
        └── utils/              # dimension.ts db.ts export.ts handover.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/trees` | `pages/TreeList.vue` | 古树一树一档：新建/编辑/级联删除、按保护级别与树种筛选、回显检查次数与最新长势等级 |
| `/trees/:id/surveys` | `pages/TreeSurvey.vue` | 树体与立地检查：录树高/胸径/冠幅/倾斜/空洞并对比上次、年化生长量、古树历史时间线 |
| `/measures` | `pages/MeasureBoard.vue` | 复壮措施台账：按类型与实施状态筛选、行内草稿、批量改状态，完成即回写最近复壮日期 |
| `/supports` | `pages/SupportBoard.vue` | 支撑加固与避雷件登记：超周期未检查自动高亮 + 顶部提醒 + 一键登记本次检查 |
| `/reviews` | `pages/ReviewView.vue` | 长势复评与结构版本：衰弱/濒危强制填写后续措施、历史时间线、JSON 导入导出 |
| `/handovers` | `pages/HandoverBoard.vue` | 管护责任移交：清册建册、两侧按古树编号逐株对账（对不上先挂起）、部分生效、归属统计 |

`/` 重定向到 `/trees`，未匹配路径统一回落到 `/trees`。
**层级路由支持直接深链**：把 `http://localhost:22815/trees/tree-guozijian-0007/surveys` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「古树档案不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbheritagetree`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`，`version(1)` 建立全部表，`version(2)` 补齐索引并执行 `.upgrade()` 迁移：
  * `surveys` 增加 `[treeId+date]` 复合索引、`measures` 增加 `operator` 索引、`supports` 增加 `lastCheckDate` 索引、`reviews` 增加 `trend` 索引；
  * 回填 `revision` / `createdAt` / `updatedAt`；
  * 为 `trees` 补齐 `lastMeasureDate`（最近复壮日期）回写字段；
  * 为 `reviews` 补齐 `followUp`（后续措施）字段；
  * 为 `supports` 补齐 `lastCheckDate` 与 `checkCycleMon` 缺省值。
  * `version(3)` 新增「管护责任移交」两张表并迁移历史数据：
    * 新增 `handovers`（移交清册，内嵌逐株对账行）与 `ownershipHistory`（归属履历，含 `[treeId+fromDate]` 复合索引）；
    * **已有数据升级时按现有管护单位补一段归属履历**（开口段、来源「升级补录」），
      起始日取该树在档最早业务日期（检查 / 措施 / 加固安装 / 复评），无业务记录则取建档日。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `trees` | id | code, species, protectLevel, ageYears, createdAt, updatedAt, owner |
  | `surveys` | id | treeId, [treeId+date], date, siteNote |
  | `measures` | id | treeId, type, state, date, operator |
  | `supports` | id | treeId, type, installDate, lastCheckDate |
  | `reviews` | id | treeId, date, vigor, trend |
  | `handovers` | id | code, fromOwner, toOwner, handoverDate, status |
  | `ownershipHistory` | id | treeId, [treeId+fromDate], owner, toDate, handoverId |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `trees` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **古树 → 树体检查 / 复壮措施 / 加固件 / 长势复评** 三层互相引用：
  * 3 株古树（京-01-0007 国槐 一级 / 京-02-0113 银杏 一级 / 京-05-0246 侧柏 二级）；
  * 9 条树体检查（每株 3 次，树高胸径随日期递增）、8 条复壮措施（覆盖计划 / 实施中 / 已完成）、
    5 件加固件（其中 **京-01-0007 支撑杆** 与 **京-05-0246 避雷** 故意超周期未检查，用于验证高亮与提醒）、
    7 条长势复评（含衰弱 / 濒危样本且均已填写后续措施）。
  * 归属履历 4 段（含 **银杏 2026-04-01 已由海淀区移交至市古树名木保护中心** 的完整履历，
    用于验证「台账按现在归属、复评按当时归属」）；移交清册 2 册（一个已完成、一个对账中待新单位登记）。
  * 固定 id 如 `tree-guozijian-0007`、`tree-xiangshan-0113`、`tree-ritan-0246` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的古树 id」这一界面偏好，不存业务数据。
* 删除古树会**级联清理**其下的树体检查、复壮措施、加固件与复评记录（同一 Dexie 事务内完成）。

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
npm run test:handover # 管护责任移交领域规则测试（esbuild 转译后在 Node 运行，无需浏览器）
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
* **管护责任移交边界**：以移交生效日 0 时为界——**移交前定稿的复评结论仍算原管护单位**；
  **交接日（含）之后的树体检查、复壮措施与加固件归新接手养护单位**。
* **清册留存**：原单位档案室留移交清册一份，新单位管自己那份；两份各自导出 / 导入 JSON 片段，互不覆盖。
* **逐株对账**：两侧按**古树编号 + 校验和**（编号、树种、保护级别、生效日的 FNV-1a 哈希）逐株比对；
  缺编号或校验和不一致的**先挂起等核对**，不阻断其余株数生效（支持部分生效）。
* **单侧重试**：任一侧重传清册片段只重算本侧状态，另一侧已确认结果不受影响。
* **两套统计口径**：台账管护株数**按现在归属**（归属履历开口段）统计；
  复评结论条数**按当时归属**（复评日期命中的履历段）统计。
* **升级补履历**：v3 升级时为已有数据**按现有管护单位补一段归属履历**，保证历史统计可回溯。
* 领域纯函数与规则测试见 `src/utils/handover.ts`、`scripts/test-handover.mjs`（`npm run test:handover`）。
