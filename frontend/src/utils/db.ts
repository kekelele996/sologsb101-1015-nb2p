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
import type { OwnershipHistory } from '../types/ownership'
import type { Handover } from '../types/handover'
import { nowIso, today, uuid } from './id'
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
  handovers!: Table<Handover, string>
  ownershipHistory!: Table<OwnershipHistory, string>

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
    this.version(DB_SCHEMA_VERSION)
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
            row.revision = ROW_REVISION
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

    // ---------- v3：管护责任移交 —— 移交清册表 + 归属履历表 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
        // 移交清册：批次主表，items 内嵌逐株对账行
        handovers: 'id, code, fromOwner, toOwner, handoverDate, status',
        // 归属履历：[treeId+fromDate] 复合索引便于按树取履历；handoverId 便于按清册回滚
        ownershipHistory: 'id, treeId, [treeId+fromDate], owner, toDate, handoverId',
      })
      .upgrade(async (tx) => {
        // 迁移：为已有数据按现有管护单位补一段归属履历（开口段，至今）。
        // 起始日取该树在档最早业务日期（检查 / 措施 / 加固安装 / 复评），无业务记录则取建档日。
        const [treeRows, surveyRows, measureRows, supportRows, reviewRows] = await Promise.all([
          tx.table('trees').toCollection().toArray() as Promise<Record<string, unknown>[]>,
          tx.table('surveys').toCollection().toArray() as Promise<Record<string, unknown>[]>,
          tx.table('measures').toCollection().toArray() as Promise<Record<string, unknown>[]>,
          tx.table('supports').toCollection().toArray() as Promise<Record<string, unknown>[]>,
          tx.table('reviews').toCollection().toArray() as Promise<Record<string, unknown>[]>,
        ])
        const stamp = nowIso()
        const segments: Record<string, unknown>[] = []
        for (const tree of treeRows) {
          const treeId = String(tree.id)
          const dates = [
            ...surveyRows.filter((row) => row.treeId === treeId).map((row) => String(row.date ?? '')),
            ...measureRows.filter((row) => row.treeId === treeId).map((row) => String(row.date ?? '')),
            ...supportRows.filter((row) => row.treeId === treeId).map((row) => String(row.installDate ?? '')),
            ...reviewRows.filter((row) => row.treeId === treeId).map((row) => String(row.date ?? '')),
          ].filter((date) => date !== '')
          dates.sort((a, b) => a.localeCompare(b))
          const createdAtDate = typeof tree.createdAt === 'string' ? tree.createdAt.slice(0, 10) : today()
          segments.push({
            id: uuid('ownership'),
            treeId,
            owner: typeof tree.owner === 'string' ? tree.owner : '',
            fromDate: dates[0] ?? createdAtDate,
            toDate: '',
            source: '升级补录',
            handoverId: '',
            note: 'v3 升级：按现有管护单位补录',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          })
        }
        await tx.table('ownershipHistory').bulkAdd(segments)
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

/** 删除古树并级联清理其检查、措施、加固、复评记录与归属履历；
 * 移交清册是双方档案室的历史凭证，删除古树不删除清册，仅保留编号快照 */
export async function removeTree(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.ownershipHistory],
    async () => {
      await db.surveys.where('treeId').equals(id).delete()
      await db.measures.where('treeId').equals(id).delete()
      await db.supports.where('treeId').equals(id).delete()
      await db.reviews.where('treeId').equals(id).delete()
      await db.ownershipHistory.where('treeId').equals(id).delete()
      await db.trees.delete(id)
    }
  )
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

/* ------------------------------ 归属履历 ------------------------------ */

export async function listOwnershipHistory(): Promise<OwnershipHistory[]> {
  const rows = await db.ownershipHistory.toArray()
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.fromDate.localeCompare(b.fromDate))
}

export async function listOwnershipByTree(treeId: string): Promise<OwnershipHistory[]> {
  const rows = await db.ownershipHistory.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.fromDate.localeCompare(b.fromDate))
}

export async function putOwnershipHistory(row: OwnershipHistory): Promise<void> {
  await db.ownershipHistory.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/* ------------------------------ 管护责任移交 ------------------------------ */

export async function listHandovers(): Promise<Handover[]> {
  const rows = await db.handovers.toArray()
  return rows.sort((a, b) => b.handoverDate.localeCompare(a.handoverDate) || b.createdAt.localeCompare(a.createdAt))
}

export async function getHandover(id: string): Promise<Handover | undefined> {
  return db.handovers.get(id)
}

export async function putHandover(row: Handover): Promise<void> {
  await db.handovers.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeHandover(id: string): Promise<void> {
  await db.transaction('rw', db.handovers, db.ownershipHistory, async () => {
    // 仅清理由本清册生成的履历段；升级补录与其他清册的履历保留
    await db.ownershipHistory.where('handoverId').equals(id).delete()
    await db.handovers.delete(id)
  })
}

/**
 * 生效移交：把清册中两侧「已核对」的株数一次性完成归属切换。
 * 同一事务内：
 * 1) 每株古树当前归属开口段封到生效日（toDate = handoverDate）；
 * 2) 追加一段新单位开口履历（fromDate = handoverDate，来源「移交清册」）；
 * 3) 古树 owner 字段同步为新单位（台账按现在归属统计以履历为准，owner 作为兜底）；
 * 4) 清册逐株状态置为「已生效」。
 * 「已挂起」株数不参与，留待核对后再生效（支持部分生效）。
 * 返回实际生效的株数。
 */
export async function applyHandover(
  handover: Handover,
  deriveStatus: (next: Handover) => Handover['status']
): Promise<number> {
  const ready = handover.items.filter((item) => item.status === '已核对')
  if (ready.length === 0) return 0
  const stamp = nowIso()
  await db.transaction(
    'rw',
    [db.handovers, db.ownershipHistory, db.trees],
    async () => {
      for (const item of ready) {
        const openSegments = await db.ownershipHistory
          .where('treeId')
          .equals(item.treeId)
          .filter((segment) => segment.toDate === '')
          .toArray()
        for (const segment of openSegments) {
          await db.ownershipHistory.update(segment.id, {
            toDate: handover.handoverDate,
            updatedAt: stamp,
          })
        }
        await db.ownershipHistory.put({
          id: uuid('ownership'),
          treeId: item.treeId,
          owner: handover.toOwner,
          fromDate: handover.handoverDate,
          toDate: '',
          source: '移交清册',
          handoverId: handover.id,
          note: `${handover.code}：由 ${handover.fromOwner} 移交`,
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        })
        await db.trees.update(item.treeId, { owner: handover.toOwner, updatedAt: stamp })
      }
      const nextItems = handover.items.map((item) =>
        item.status === '已核对' ? { ...item, status: '已生效' as const } : item
      )
      const next: Handover = { ...handover, items: nextItems }
      await db.handovers.put({ ...next, status: deriveStatus(next), updatedAt: stamp, revision: ROW_REVISION })
    }
  )
  return ready.length
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
  handovers: Handover[]
  ownershipHistory: OwnershipHistory[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews, handovers, ownershipHistory] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.reviews.toArray(),
    db.handovers.toArray(),
    db.ownershipHistory.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    trees,
    surveys,
    measures,
    supports,
    reviews,
    handovers,
    ownershipHistory,
  }
}

/** 用快照覆盖整库（导入存档）；兼容 v2 及更早存档（缺移交两表时按空表导入） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.handovers, db.ownershipHistory],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.handovers.clear(),
        db.ownershipHistory.clear(),
      ])
      await db.trees.bulkPut(snapshot.trees.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.measures.bulkPut(snapshot.measures.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.supports.bulkPut(snapshot.supports.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.reviews.bulkPut(snapshot.reviews.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.handovers.bulkPut((snapshot.handovers ?? []).map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.ownershipHistory.bulkPut(
        (snapshot.ownershipHistory ?? []).map((row) => ({ ...row, revision: ROW_REVISION }))
      )
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.handovers, db.ownershipHistory],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.handovers.clear(),
        db.ownershipHistory.clear(),
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews, handovers, ownershipHistory] = await Promise.all([
    db.trees.count(),
    db.surveys.count(),
    db.measures.count(),
    db.supports.count(),
    db.reviews.count(),
    db.handovers.count(),
    db.ownershipHistory.count(),
  ])
  return { trees, surveys, measures, supports, reviews, handovers, ownershipHistory }
}
