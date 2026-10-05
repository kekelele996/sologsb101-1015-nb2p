/**
 * IndexedDB 集成测试（fake-indexeddb）：
 * 1) 手工建一个 v2 旧库（无 handovers / ownershipHistory），打开 v3 后验证升级补履历；
 * 2) 建册 → 两侧对账一致 → 生效事务 → 验证封旧段/开新段/回写 owner；
 * 3) 挂起株不生效；删除清册仅回滚其生成的履历段。
 * 运行：node scripts/test-db-upgrade.mjs
 */
import 'fake-indexeddb/auto'
import { build as esbuild } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
async function load(path) {
  const bundled = await esbuild({
    entryPoints: [resolve(here, path)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  })
  const url = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
  return import(url)
}

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

/* ----------------------- 1) 建 v2 旧库（绕过 v3 定义） ----------------------- */
const DexieMod = await import('dexie')
const Dexie = DexieMod.default

function oldDb() {
  const d = new Dexie('gbheritagetree')
  d.version(2).stores({
    trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
    surveys: 'id, treeId, [treeId+date], date, siteNote',
    measures: 'id, treeId, type, state, date, operator',
    supports: 'id, treeId, type, installDate, lastCheckDate',
    reviews: 'id, treeId, date, vigor, trend',
  })
  return d
}

const stamp = '2025-01-01T00:00:00.000Z'
{
  const d = oldDb()
  await d.open()
  await d.table('trees').bulkPut([
    {
      id: 't1',
      code: '京-01-0007',
      species: '国槐',
      protectLevel: '一级',
      ageYears: 300,
      location: '测试点 A',
      owner: '东城区园林绿化局',
      lastMeasureDate: '',
      createdAt: '2023-01-01T00:00:00.000Z',
      updatedAt: stamp,
      revision: 2,
    },
    {
      id: 't2',
      code: '京-02-0113',
      species: '银杏',
      protectLevel: '一级',
      ageYears: 260,
      location: '测试点 B',
      owner: '海淀区园林绿化服务中心',
      lastMeasureDate: '',
      createdAt: '2024-02-01T00:00:00.000Z',
      updatedAt: stamp,
      revision: 2,
    },
  ])
  await d.table('surveys').bulkPut([
    { id: 's1', treeId: 't1', date: '2023-05-18', heightM: 14, dbhCm: 90, crownM: 12, leanDeg: 3, hollowCount: 0, siteNote: '裸土', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 's2', treeId: 't1', date: '2024-06-02', heightM: 14, dbhCm: 91, crownM: 12, leanDeg: 3, hollowCount: 0, siteNote: '裸土', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ])
  await d.close()
}

/* ----------------------- 2) 打开 v3，验证升级迁移 ----------------------- */
const v3 = await load('../src/utils/db.ts')
assert.equal(v3.DB_SCHEMA_VERSION, 3, '当前应是 v3')
await v3.db.open()
// 空树才播种，我们已有数据所以不会播种
assert.equal((await v3.db.trees.count()), 2)

let history = await v3.db.ownershipHistory.toArray()
check('v3 升级为每株古树补一段开口归属履历（按现有管护单位）', () => {
  assert.equal(history.length, 2)
  const t1 = history.find((h) => h.treeId === 't1')
  assert.equal(t1.owner, '东城区园林绿化局')
  assert.equal(t1.toDate, '')
  assert.equal(t1.source, '升级补录')
  // 起始日 = 在档最早业务日期 2023-05-18
  assert.equal(t1.fromDate, '2023-05-18')
  const t2 = history.find((h) => h.treeId === 't2')
  // t2 无业务记录 → 取建档日 2024-02-01
  assert.equal(t2.fromDate, '2024-02-01')
  assert.equal(t2.owner, '海淀区园林绿化服务中心')
})

/* ----------------------- 3) 建册 → 两侧对账 → 生效 ----------------------- */
const handoverUtil = await load('../src/utils/handover.ts')

const handoverDate = '2026-04-01'
const draft = {
  id: 'h1',
  code: 'YJ-test-001',
  fromOwner: '东城区园林绿化局',
  toOwner: '市古树名木保护中心',
  handoverDate,
  status: '草稿',
  items: [handoverUtil.buildItem({ id: 't1', code: '京-01-0007', species: '国槐', protectLevel: '一级' }, handoverDate)],
  archivedFrom: false,
  archivedTo: false,
  fromSideImportedAt: '',
  toSideImportedAt: '',
  reconciledAt: '',
  createdAt: stamp,
  updatedAt: stamp,
  revision: 3,
}

// 模拟两侧各自导出片段并对账
const fromManifest = handoverUtil.buildManifest(draft, 'from', stamp)
const r1 = handoverUtil.reconcileManifest(draft, 'from', fromManifest)
let cur = { ...draft, items: r1.items, fromSideImportedAt: stamp }
const toManifest = handoverUtil.buildManifest(cur, 'to', stamp)
const r2 = handoverUtil.reconcileManifest(cur, 'to', toManifest)
cur = { ...cur, items: r2.items, toSideImportedAt: stamp, reconciledAt: stamp }

check('两侧对账一致后株数为「已核对」，可生效', () => {
  assert.equal(r2.matched, 1)
  assert.equal(cur.items[0].status, '已核对')
  assert.equal(handoverUtil.deriveBatchStatus(cur), '对账中')
})

cur.status = handoverUtil.deriveBatchStatus(cur)
const applied = await v3.applyHandover(cur, handoverUtil.deriveBatchStatus)
check('生效事务：封旧段到生效日、追加新单位开口段、回写 trees.owner、清册状态置已生效', async () => {
  assert.equal(applied, 1)
  const segments = await v3.db.ownershipHistory.where('treeId').equals('t1').toArray()
  const sorted = segments.sort((a, b) => a.fromDate.localeCompare(b.fromDate))
  assert.equal(sorted.length, 2)
  assert.equal(sorted[0].owner, '东城区园林绿化局')
  assert.equal(sorted[0].toDate, handoverDate)
  assert.equal(sorted[1].owner, '市古树名木保护中心')
  assert.equal(sorted[1].fromDate, handoverDate)
  assert.equal(sorted[1].toDate, '')
  assert.equal(sorted[1].source, '移交清册')
  assert.equal(sorted[1].handoverId, 'h1')
  const tree = await v3.db.trees.get('t1')
  assert.equal(tree.owner, '市古树名木保护中心')
  const saved = await v3.db.handovers.get('h1')
  assert.equal(saved.items[0].status, '已生效')
  assert.equal(saved.status, '已完成')
})

/* ----------------------- 4) 生效后再建第二册（挂起 + 部分生效） ----------------------- */
const draft2 = {
  id: 'h2',
  code: 'YJ-test-002',
  fromOwner: '海淀区园林绿化服务中心',
  toOwner: '市古树名木保护中心',
  handoverDate: '2026-06-01',
  status: '草稿',
  items: [
    handoverUtil.buildItem({ id: 't2', code: '京-02-0113', species: '银杏', protectLevel: '一级' }, '2026-06-01'),
    handoverUtil.buildItem({ id: 't1', code: '京-01-0007', species: '国槐', protectLevel: '一级' }, '2026-06-01'),
  ],
  archivedFrom: false,
  archivedTo: false,
  fromSideImportedAt: '',
  toSideImportedAt: '',
  reconciledAt: '',
  createdAt: stamp,
  updatedAt: stamp,
  revision: 3,
}
// 原单位两侧只有 t2 一致；t1 新单位缺编号 → 挂起
const from2 = handoverUtil.buildManifest(draft2, 'from', stamp)
const rr1 = handoverUtil.reconcileManifest(draft2, 'from', from2)
let cur2 = { ...draft2, items: rr1.items, fromSideImportedAt: stamp }
const to2Manifest = handoverUtil.buildManifest(cur2, 'to', stamp)
to2Manifest.entries = to2Manifest.entries.filter((e) => e.code === '京-02-0113')
const rr2 = handoverUtil.reconcileManifest(cur2, 'to', to2Manifest)
cur2 = { ...cur2, items: rr2.items, toSideImportedAt: stamp, reconciledAt: stamp }

check('缺编号株挂起；只生效已核对株（部分生效），挂起株归属不变', async () => {
  assert.equal(rr2.pending, 1)
  assert.equal(rr2.matched, 1)
  cur2.status = handoverUtil.deriveBatchStatus(cur2)
  const n = await v3.applyHandover(cur2, handoverUtil.deriveBatchStatus)
  assert.equal(n, 1)
  const saved = await v3.db.handovers.get('h2')
  assert.equal(saved.status, '部分生效')
  const t1Segs = await v3.db.ownershipHistory.where('treeId').equals('t1').toArray()
  // t1 仍是市古树名木保护中心（h1 生效的开口段），没有被 h2 动
  const open = t1Segs.filter((s) => s.toDate === '')
  assert.equal(open.length, 1)
  assert.equal(open[0].owner, '市古树名木保护中心')
  const t2Tree = await v3.db.trees.get('t2')
  assert.equal(t2Tree.owner, '市古树名木保护中心')
})

/* ----------------------- 5) 删除清册只回滚其履历段 ----------------------- */
await v3.removeHandover('h2')
check('删除清册仅清除该清册生成的履历段，h1 与升级补录段保留', async () => {
  const all = await v3.db.ownershipHistory.toArray()
  // t2 的 h2 开口段被删，升级补录段保留
  const t2Segs = all.filter((h) => h.treeId === 't2')
  assert.equal(t2Segs.length, 1)
  assert.equal(t2Segs[0].source, '升级补录')
  // t1 的 h1 两段都在
  const t1Segs = all.filter((h) => h.treeId === 't1')
  assert.equal(t1Segs.length, 2)
  assert.equal(await v3.db.handovers.get('h2'), undefined)
})

console.log(`\n全部 ${passed} 组集成测试通过。`)
process.exit(0)
