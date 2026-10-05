/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import type { Transfer, TransferSide, TransferStatus } from '../types/transfer'
import { nowIso, today, uuid } from './id'
import { deriveReconcileState } from './attribution'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  reviews!: Table<Review, string>
  transfers!: Table<Transfer, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt',
      surveys: 'id, treeId, date',
      measures: 'id, treeId, type, state, date',
      supports: 'id, treeId, type, installDate',
      reviews: 'id, treeId, date, vigor',
    })

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        // 复合索引 [treeId+date]：按古树 + 日期快速取检查记录
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('trees'),
          tx.table('surveys'),
          tx.table('measures'),
          tx.table('supports'),
          tx.table('reviews'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = 2
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：古树补齐「最近复壮日期」
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastMeasureDate !== 'string') row.lastMeasureDate = ''
        })
        // 迁移 3：复评补齐「后续措施」
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.followUp !== 'string') row.followUp = ''
        })
        // 迁移 4：加固件补齐「最近检查日期」
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
        })
      })

    // ---------- v3：新增管护移交表，古树补归属履历 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
        // 新表：管护责任移交清册（逐株一册，两侧各留一份）
        transfers: 'id, treeId, code, fromOwner, toOwner, handoverDate, status, reconcile',
      })
      .upgrade(async (tx) => {
        // 迁移 1：已有数据按现有管护单位补一段归属履历（只补一次）
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (!Array.isArray(row.ownershipHistory)) {
            row.ownershipHistory =
              typeof row.owner === 'string' && row.owner.trim() !== ''
                ? [{ owner: row.owner, startDate: '', note: '历史数据升级补录' }]
                : []
          }
          row.revision = ROW_REVISION
        })
        // 迁移 2：其余各表行修订号统一升到当前版本
        for (const name of ['surveys', 'measures', 'supports', 'reviews']) {
          await tx.table(name).toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
          })
        }
      })
  }
}

export const db = new HeritageTreeDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.trees.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 古树 -------------------------------- */

export async function listTrees(): Promise<Tree[]> {
  const rows = await db.trees.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function getTree(id: string): Promise<Tree | undefined> {
  return db.trees.get(id)
}

export async function putTree(row: Tree): Promise<void> {
  await db.trees.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除古树并级联清理其检查、措施、加固、复评与移交记录 */
export async function removeTree(id: string): Promise<void> {
  await db.transaction('rw', [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.transfers], async () => {
    await db.surveys.where('treeId').equals(id).delete()
    await db.measures.where('treeId').equals(id).delete()
    await db.supports.where('treeId').equals(id).delete()
    await db.reviews.where('treeId').equals(id).delete()
    await db.transfers.where('treeId').equals(id).delete()
    await db.trees.delete(id)
  })
}

/* ------------------------------ 树体检查 ------------------------------ */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray()
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.date.localeCompare(b.date))
}

export async function listSurveysByTree(treeId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putSurvey(row: Survey): Promise<void> {
  await db.surveys.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id)
}

/* ------------------------------ 复壮措施 ------------------------------ */

export async function listMeasures(): Promise<Measure[]> {
  const rows = await db.measures.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listMeasuresByTree(treeId: string): Promise<Measure[]> {
  const rows = await db.measures.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 写入复壮措施。
 * 措施状态为「已完成」时，回写古树的最近复壮日期（仅当本次日期更新时）。
 */
export async function putMeasure(row: Measure): Promise<void> {
  await db.transaction('rw', db.trees, db.measures, async () => {
    await db.measures.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
    if (row.state !== '已完成') return
    const tree = await db.trees.get(row.treeId)
    if (!tree) return
    if (tree.lastMeasureDate >= row.date) return
    await db.trees.update(tree.id, { lastMeasureDate: row.date, updatedAt: nowIso() })
  })
}

export async function removeMeasure(id: string): Promise<void> {
  await db.measures.delete(id)
}

/** 批量修改措施状态；改为「已完成」时同步回写古树最近复壮日期 */
export async function batchSetMeasureState(ids: string[], state: MeasureState): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db.measures.bulkGet(ids)
  const list = rows.filter((row): row is Measure => row !== undefined)
  for (const row of list) {
    await putMeasure({ ...row, state })
  }
  return list.length
}

/* ------------------------------ 加固件 ------------------------------ */

export async function listSupports(): Promise<Support[]> {
  const rows = await db.supports.toArray()
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  return db.supports.where('treeId').equals(treeId).toArray()
}

export async function putSupport(row: Support): Promise<void> {
  await db.supports.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSupport(id: string): Promise<void> {
  await db.supports.delete(id)
}

/** 登记本次检查：把最近检查日期置为给定日期（默认今天） */
export async function markSupportChecked(id: string, date = today()): Promise<void> {
  await db.supports.update(id, { lastCheckDate: date, updatedAt: nowIso() })
}

/* ------------------------------ 长势复评 ------------------------------ */

export async function listReviews(): Promise<Review[]> {
  const rows = await db.reviews.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listReviewsByTree(treeId: string): Promise<Review[]> {
  const rows = await db.reviews.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReview(row: Review): Promise<void> {
  await db.reviews.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeReview(id: string): Promise<void> {
  await db.reviews.delete(id)
}

/* ------------------------------ 管护移交 ------------------------------ */

export async function listTransfers(): Promise<Transfer[]> {
  const rows = await db.transfers.toArray()
  return rows.sort((a, b) => b.handoverDate.localeCompare(a.handoverDate) || a.code.localeCompare(b.code))
}

export async function listTransfersByTree(treeId: string): Promise<Transfer[]> {
  const rows = await db.transfers.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.handoverDate.localeCompare(a.handoverDate))
}

export async function getTransfer(id: string): Promise<Transfer | undefined> {
  return db.transfers.get(id)
}

/** 新建移交清册：原单位默认留存，新单位份由登记人确认；原单位取古树当前管护单位 */
export async function createTransfer(input: {
  tree: Tree
  toOwner: string
  handoverDate: string
  fromArchived?: boolean
  toArchived?: boolean
  note?: string
}): Promise<Transfer> {
  const { tree, toOwner, handoverDate } = input
  const stamp = nowIso()
  const row: Transfer = {
    id: uuid('transfer'),
    code: `移-${handoverDate.replace(/-/g, '')}-${tree.code.slice(-4)}`,
    treeId: tree.id,
    treeCode: tree.code,
    fromOwner: tree.owner,
    toOwner: toOwner.trim(),
    handoverDate,
    status: '待确认',
    fromArchived: input.fromArchived ?? true,
    toArchived: input.toArchived ?? true,
    reconcile: '一致',
    lastRetrySide: '',
    note: input.note?.trim() ?? '',
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  }
  row.reconcile = deriveReconcileState(row.status, row.fromArchived, row.toArchived)
  await db.transfers.put(row)
  return row
}

export async function putTransfer(row: Transfer): Promise<void> {
  await db.transfers.put({
    ...row,
    reconcile: deriveReconcileState(row.status, row.fromArchived, row.toArchived),
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  })
}

export async function removeTransfer(id: string): Promise<void> {
  await db.transfers.delete(id)
}

/**
 * 确认移交：两侧清册逐株对账一致后才能确认。
 * 确认时把古树当前管护单位切到新单位，并在归属履历追加一段（不覆盖历史）。
 * 交接前定稿的复评结论归属不变，交接后的检查 / 措施 / 加固归新单位（按日期口径派生）。
 */
export async function confirmTransfer(id: string): Promise<Transfer> {
  return db.transaction('rw', db.trees, db.transfers, async () => {
    const row = await db.transfers.get(id)
    if (!row) throw new Error('移交清册不存在')
    const state = deriveReconcileState(row.status, row.fromArchived, row.toArchived)
    if (state !== '一致') {
      throw new Error(`对账未通过（${state}），请核对一致后再确认；对不上的条目需先挂起。`)
    }
    const tree = await db.trees.get(row.treeId)
    if (tree) {
      const history = Array.isArray(tree.ownershipHistory) ? tree.ownershipHistory : []
      const already = history.some((seg) => seg.transferId === row.id)
      const nextHistory = already
        ? history
        : [
            ...history,
            { owner: row.toOwner, startDate: row.handoverDate, note: '管护移交', transferId: row.id },
          ]
      await db.trees.update(tree.id, {
        owner: row.toOwner,
        ownershipHistory: nextHistory,
        updatedAt: nowIso(),
      })
    }
    const next: Transfer = { ...row, status: '已确认' as TransferStatus, reconcile: '一致' }
    await db.transfers.put({ ...next, updatedAt: nowIso(), revision: ROW_REVISION })
    return next
  })
}

/** 对不上的条目先挂起，等待核对 */
export async function suspendTransfer(id: string): Promise<void> {
  await db.transfers.update(id, {
    status: '已挂起' as TransferStatus,
    reconcile: '挂起待核',
    updatedAt: nowIso(),
  })
}

/** 挂起条目核对清楚后恢复为待确认 */
export async function resumeTransfer(id: string): Promise<void> {
  const row = await db.transfers.get(id)
  if (!row) return
  await db.transfers.update(id, {
    status: '待确认' as TransferStatus,
    reconcile: deriveReconcileState('待确认', row.fromArchived, row.toArchived),
    updatedAt: nowIso(),
  })
}

/**
 * 某一侧清册出错时只重试本侧：登记本侧归档状态，不触碰另一侧。
 * 返回是否两侧均已留存（决定对账是否一致）。
 */
export async function retryTransferSide(id: string, side: TransferSide): Promise<Transfer | undefined> {
  const row = await db.transfers.get(id)
  if (!row) return undefined
  const patch: Partial<Transfer> = { lastRetrySide: side, updatedAt: nowIso() }
  if (side === 'from') patch.fromArchived = true
  if (side === 'to') patch.toArchived = true
  await db.transfers.update(id, patch)
  return db.transfers.get(id)
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  trees: Tree[]
  surveys: Survey[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
  transfers: Transfer[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews, transfers] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.reviews.toArray(),
    db.transfers.toArray(),
  ])
  return { name: DB_NAME, schemaVersion: DB_SCHEMA_VERSION, exportedAt: nowIso(), trees, surveys, measures, supports, reviews, transfers }
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.transfers], async () => {
    await Promise.all([
      db.trees.clear(),
      db.surveys.clear(),
      db.measures.clear(),
      db.supports.clear(),
      db.reviews.clear(),
      db.transfers.clear(),
    ])
    await db.trees.bulkPut(snapshot.trees.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.measures.bulkPut(snapshot.measures.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.supports.bulkPut(snapshot.supports.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.reviews.bulkPut(snapshot.reviews.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.transfers.bulkPut(snapshot.transfers.map((row) => ({ ...row, revision: ROW_REVISION })))
  })
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.transfers], async () => {
    await Promise.all([
      db.trees.clear(),
      db.surveys.clear(),
      db.measures.clear(),
      db.supports.clear(),
      db.reviews.clear(),
      db.transfers.clear(),
    ])
  })
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews, transfers] = await Promise.all([
    db.trees.count(),
    db.surveys.count(),
    db.measures.count(),
    db.supports.count(),
    db.reviews.count(),
    db.transfers.count(),
  ])
  return { trees, surveys, measures, supports, reviews, transfers }
}
