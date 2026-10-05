/**
 * 管护责任移交核心规则测试（零依赖，esbuild 转译后在 Node 运行）
 * 运行：node scripts/test-handover.mjs
 * 覆盖：责任边界、校验和、两侧对账（含挂起/只重试本侧）、批次状态、归属统计、清册片段解析。
 */
import { build as esbuild } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, '../src/utils/handover.ts')

const bundled = await esbuild({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const code = bundled.outputFiles[0].text
const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const mod = await import(dataUrl)
const {
  belongsToNewUnit,
  reviewBelongsToOldUnit,
  itemChecksum,
  buildItem,
  reconcileManifest,
  deriveBatchStatus,
  buildManifest,
  parseManifest,
  effectiveItems,
  currentOwner,
  ownerAtDate,
  countTreesByCurrentOwner,
  reviewStatsByOwnerAtTime,
} = mod

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

/* ------------------------------- 责任边界 ------------------------------- */

check('生效日之前定稿的复评结论仍算原单位，生效日当天及之后算新单位', () => {
  assert.equal(reviewBelongsToOldUnit('2026-03-31', '2026-04-01'), true)
  assert.equal(reviewBelongsToOldUnit('2026-04-01', '2026-04-01'), false)
  assert.equal(belongsToNewUnit('2026-04-01', '2026-04-01', 'review'), true)
})

check('交接日（含）之后的树体检查 / 复壮措施 / 加固件归新单位', () => {
  for (const kind of ['survey', 'measure', 'support']) {
    assert.equal(belongsToNewUnit('2026-03-31', '2026-04-01', kind), false)
    assert.equal(belongsToNewUnit('2026-04-01', '2026-04-01', kind), true)
    assert.equal(belongsToNewUnit('2026-05-10', '2026-04-01', kind), true)
  }
})

/* -------------------------------- 校验和 -------------------------------- */

check('校验和：同内容稳定；树种/保护级别/生效日任一变化即不同', () => {
  const a = itemChecksum('京-02-0113', '银杏', '一级', '2026-04-01')
  assert.equal(a, itemChecksum('京-02-0113', '银杏', '一级', '2026-04-01'))
  assert.notEqual(a, itemChecksum('京-02-0113', '国槐', '一级', '2026-04-01'))
  assert.notEqual(a, itemChecksum('京-02-0113', '银杏', '二级', '2026-04-01'))
  assert.notEqual(a, itemChecksum('京-02-0113', '银杏', '一级', '2026-05-01'))
  assert.match(a, /^[0-9a-f]{8}$/)
})

/* -------------------------------- 测试夹具 -------------------------------- */

const ginkgo = { id: 't1', code: '京-02-0113', species: '银杏', protectLevel: '一级', owner: '海淀区园林绿化服务中心' }
const cypress = { id: 't2', code: '京-05-0246', species: '侧柏', protectLevel: '二级', owner: '朝阳区公园管理中心' }
const date = '2026-04-01'

function makeHandover() {
  const item1 = buildItem(ginkgo, date)
  const item2 = buildItem(cypress, date)
  return {
    id: 'h1',
    code: 'YJ-20260330-001',
    fromOwner: '原单位',
    toOwner: '新单位',
    handoverDate: date,
    items: [item1, item2],
    fromSideImportedAt: '',
    toSideImportedAt: '',
    reconciledAt: '',
  }
}

/* ------------------------------- 两侧对账 ------------------------------- */

check('两侧均确认一致 → 已核对；缺编号或校验和不符 → 挂起', () => {
  const handover = makeHandover()
  // 原单位侧导出的片段（两侧一致）
  const fromManifest = buildManifest(
    { ...handover, fromSideImportedAt: 'x', toSideImportedAt: '' },
    'from',
    '2026-03-30T00:00:00Z'
  )
  const r1 = reconcileManifest(handover, 'from', fromManifest)
  assert.equal(r1.matched, 0) // 新单位侧尚未登记，仍待对账
  assert.equal(r1.waiting, 2)

  // 新单位侧：银杏一致，侧柏编号缺失 → 侧柏挂起
  const toManifest = {
    ...buildManifest(handover, 'to', '2026-03-30T01:00:00Z'),
    entries: [fromManifest.entries.find((e) => e.code === '京-02-0113')],
  }
  const afterFrom = { ...handover, items: r1.items, fromSideImportedAt: 'x' }
  const r2 = reconcileManifest(afterFrom, 'to', toManifest)
  assert.equal(r2.matched, 1)
  assert.equal(r2.pending, 1)
  const cypressItem = r2.items.find((i) => i.code === '京-05-0246')
  assert.equal(cypressItem.status, '已挂起')
  assert.match(cypressItem.note, /新单位清册缺少该编号/)
})

check('校验和不一致（档案被串改）→ 已登记但挂起', () => {
  const handover = makeHandover()
  const fromManifest = buildManifest(handover, 'from', 'x')
  const r1 = reconcileManifest(handover, 'from', fromManifest)
  const afterFrom = { ...handover, items: r1.items, fromSideImportedAt: 'x' }
  const tampered = buildManifest(afterFrom, 'to', 'x')
  tampered.entries[0] = { ...tampered.entries[0], species: '国槐', checksum: itemChecksum('京-02-0113', '国槐', '一级', date) }
  const r2 = reconcileManifest(afterFrom, 'to', tampered)
  assert.equal(r2.pending, 1)
  assert.equal(r2.items[0].toState, '已登记')
  assert.match(r2.items[0].note, /新单位侧校验和不一致/)
})

check('任一侧重传只重试本侧，不影响另一侧已确认结果', () => {
  const handover = makeHandover()
  // 两侧完整一致
  const rFrom = reconcileManifest(handover, 'from', buildManifest(handover, 'from', 'x'))
  let cur = { ...handover, items: rFrom.items, fromSideImportedAt: 'x' }
  const rTo = reconcileManifest(cur, 'to', buildManifest(cur, 'to', 'x'))
  cur = { ...cur, items: rTo.items, toSideImportedAt: 'x' }
  assert.equal(rTo.matched, 2)
  assert.ok(cur.items.every((i) => i.fromState === '确认无误' && i.toState === '确认无误'))

  // 原单位侧重传一份错误片段：只有原单位侧状态变化，新单位侧确认保留
  const badFrom = buildManifest(cur, 'from', 'x2')
  badFrom.entries = [badFrom.entries[0]] // 缺侧柏
  const rRetry = reconcileManifest(cur, 'from', badFrom)
  const cypress = rRetry.items.find((i) => i.code === '京-05-0246')
  assert.equal(cypress.fromState, '未登记')
  assert.equal(cypress.toState, '确认无误') // 新单位侧不受影响
  assert.equal(cypress.status, '已挂起')
})

check('清册片段必须校验 side / kind / handoverCode 归属，防止交错侧导入', () => {
  const handover = makeHandover()
  const manifest = buildManifest(handover, 'from', 'x')
  assert.equal(parseManifest(JSON.stringify(manifest)).ok, true)
  const badKind = { ...manifest, kind: 'other' }
  assert.equal(parseManifest(JSON.stringify(badKind)).ok, false)
  const badSide = { ...manifest, side: 'weird' }
  assert.equal(parseManifest(JSON.stringify(badSide)).ok, false)
  assert.equal(parseManifest('{not json').ok, false)
})

/* ------------------------------- 批次状态 ------------------------------- */

check('deriveBatchStatus：草稿 → 对账中 → 部分生效 → 已完成', () => {
  const handover = makeHandover()
  assert.equal(deriveBatchStatus(handover), '草稿')
  const rFrom = reconcileManifest(handover, 'from', buildManifest(handover, 'from', 'x'))
  assert.equal(deriveBatchStatus({ ...handover, items: rFrom.items, fromSideImportedAt: 'x' }), '对账中')
  const oneEffective = {
    ...handover,
    items: [{ ...handover.items[0], status: '已生效' }, handover.items[1]],
  }
  assert.equal(deriveBatchStatus(oneEffective), '部分生效')
  const allEffective = { ...handover, items: handover.items.map((i) => ({ ...i, status: '已生效' })) }
  assert.equal(deriveBatchStatus(allEffective), '已完成')
  assert.equal(effectiveItems(oneEffective).length, 0) // 已核对才可生效，已生效不在待生效列表
})

/* ------------------------------- 归属统计 ------------------------------- */

const history = [
  { id: 'h-a1', treeId: 't1', owner: '海淀区园林绿化服务中心', fromDate: '2024-07-18', toDate: '2026-04-01' },
  { id: 'h-a2', treeId: 't1', owner: '市古树名木保护中心', fromDate: '2026-04-01', toDate: '' },
  { id: 'h-b1', treeId: 't2', owner: '朝阳区公园管理中心', fromDate: '2024-08-15', toDate: '' },
]

check('当前归属取开口段（台账按现在归属统计管护株数）', () => {
  assert.equal(currentOwner(history, 't1'), '市古树名木保护中心')
  assert.equal(currentOwner(history, 't2'), '朝阳区公园管理中心')
  const counts = countTreesByCurrentOwner([ginkgo, cypress], history)
  assert.deepEqual(counts, { 市古树名木保护中心: 1, 朝阳区公园管理中心: 1 })
})

check('时点归属按日期落段（复评结论按当时归属统计）', () => {
  assert.equal(ownerAtDate(history, 't1', '2024-07-25'), '海淀区园林绿化服务中心')
  assert.equal(ownerAtDate(history, 't1', '2026-04-01'), '市古树名木保护中心')
  assert.equal(ownerAtDate(history, 't1', '2026-07-22'), '市古树名木保护中心')
  assert.equal(ownerAtDate(history, 't2', '2025-09-05'), '朝阳区公园管理中心')

  // t1 两条复评：2024 年算原单位，2026 年算新单位；t2 两条均算朝阳
  const reviews = [
    { id: 'r1', treeId: 't1', date: '2024-07-25' },
    { id: 'r2', treeId: 't1', date: '2026-07-22' },
    { id: 'r3', treeId: 't2', date: '2025-09-05' },
    { id: 'r4', treeId: 't2', date: '2026-07-20' },
  ]
  const stats = reviewStatsByOwnerAtTime([ginkgo, cypress], reviews, history)
  assert.equal(stats['海淀区园林绿化服务中心'].reviewCount, 1)
  assert.equal(stats['市古树名木保护中心'].reviewCount, 1)
  assert.equal(stats['朝阳区公园管理中心'].reviewCount, 2)
  assert.equal(stats['朝阳区公园管理中心'].treeCount, 1)
})

check('无履历命中时按古树 owner 兜底，彻底无归属归入「归属待核对」', () => {
  const reviews = [{ id: 'r', treeId: 'tx', date: '2026-01-01' }]
  const stats = reviewStatsByOwnerAtTime([{ ...ginkgo, id: 'tx' }], reviews, history)
  assert.equal(stats['海淀区园林绿化服务中心'].reviewCount, 1)
  const stats2 = reviewStatsByOwnerAtTime([], reviews, history)
  assert.equal(stats2['归属待核对'].reviewCount, 1)
})

console.log(`\n全部 ${passed} 组规则测试通过。`)
