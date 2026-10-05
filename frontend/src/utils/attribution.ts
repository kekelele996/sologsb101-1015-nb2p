/**
 * 管护归属口径与逐株对账工具（纯函数）
 *
 * 口径约定：
 * - 台账按「现在归属」统计管护株数：即古树当前的 owner。
 * - 复评结论按「当时归属」统计：交接日之前定稿的复评结论仍算原单位，
 *   交接日及以后的复评结论算新单位（结论归属随日期，不随后续 owner 变更而改写）。
 * - 交接日之后的树体检查、复壮措施、加固件归新单位。
 * - 两侧按古树编号逐株对账，对不上的先挂起等核对。
 */
import type { Transfer, TransferSide, TransferStatus } from '../types/transfer'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'

/** 日期是否在交接日（含）之后；交接日当天起归新单位 */
export function isAfterHandover(date: string, handoverDate: string): boolean {
  if (date === '' || handoverDate === '') return false
  return date.localeCompare(handoverDate) >= 0
}

/** 某条按日期归属的记录是否归新接手单位（交接日及以后） */
export function belongsToNewUnit(date: string, handoverDate: string): boolean {
  return isAfterHandover(date, handoverDate)
}

/**
 * 取某株古树当前生效的移交记录（已确认且交接日不晚于参考日的最近一条）。
 * 没有则返回 null —— 此时归属口径全部回落到古树当前 owner。
 */
export function activeTransferOf(transfers: Transfer[], treeId: string, reference: string): Transfer | null {
  const list = transfers
    .filter((row) => row.treeId === treeId && row.status === '已确认' && row.handoverDate <= reference)
    .sort((a, b) => b.handoverDate.localeCompare(a.handoverDate))
  return list.length > 0 ? list[0] : null
}

/**
 * 按日期解析某株古树当时的管护单位（支持多次移交链路 A → B → C）：
 * - 无已确认移交 → 古树当前 owner
 * - 日期早于第一次交接 → 第一次移交的原单位
 * - 落在某次交接之后（到下一次交接前）→ 该次移交的新单位
 * 仅取已确认移交；待确认 / 挂起的不影响归属。
 */
export function ownerAtDate(
  transfers: Transfer[],
  treeId: string,
  tree: Pick<Tree, 'owner'>,
  date: string
): string {
  const chain = transfers
    .filter((row) => row.treeId === treeId && row.status === '已确认')
    .sort((a, b) => a.handoverDate.localeCompare(b.handoverDate))
  if (chain.length === 0) return tree.owner
  if (date < chain[0].handoverDate) return chain[0].fromOwner
  const effective = [...chain].reverse().find((row) => date >= row.handoverDate)
  return effective ? effective.toOwner : chain[0].fromOwner
}

/**
 * 复评结论按「当时归属」归属到单位名。
 * 交接日之前定稿 → 原单位；交接日及以后 → 新单位。
 * 没有移交记录 → 古树当前 owner。
 */
export function reviewOwnerAt(
  review: Pick<Review, 'date'>,
  tree: Pick<Tree, 'owner'>,
  transfer: Transfer | null
): string {
  if (transfer === null) return tree.owner
  return belongsToNewUnit(review.date, transfer.handoverDate) ? transfer.toOwner : transfer.fromOwner
}

/**
 * 树体检查 / 复壮措施 / 加固件按交接日归属到单位名。
 * 加固件以安装日期为准（交接前安装归原单位，交接后安装归新单位）。
 */
export function recordOwnerAt(
  date: string,
  tree: Pick<Tree, 'owner'>,
  transfer: Transfer | null
): string {
  if (transfer === null) return tree.owner
  return belongsToNewUnit(date, transfer.handoverDate) ? transfer.toOwner : transfer.fromOwner
}

export interface OwnerCustodyCount {
  /** 单位名称 */
  owner: string
  /** 现在归属的管护株数（按古树当前 owner 统计） */
  treeCount: number
}

/** 台账统计：按现在归属（古树当前 owner）汇总管护株数 */
export function countTreesByCurrentOwner(trees: Tree[]): OwnerCustodyCount[] {
  const map = new Map<string, number>()
  trees.forEach((tree) => {
    const owner = tree.owner.trim() === '' ? '（未填管护单位）' : tree.owner
    map.set(owner, (map.get(owner) ?? 0) + 1)
  })
  return Array.from(map.entries())
    .map(([owner, treeCount]) => ({ owner, treeCount }))
    .sort((a, b) => b.treeCount - a.treeCount || a.owner.localeCompare(b.owner, 'zh-Hans-CN'))
}

export interface ReviewOwnerCount {
  owner: string
  /** 按当时归属统计的复评结论条数 */
  reviewCount: number
}

/**
 * 复评结论按当时归属统计：每条复评依据其日期与该株的移交链路归属到单位。
 */
export function countReviewsByOwnerAtTime(
  trees: Tree[],
  reviews: Review[],
  transfers: Transfer[],
  _reference: string
): ReviewOwnerCount[] {
  const treeMap = new Map(trees.map((tree) => [tree.id, tree]))
  const map = new Map<string, number>()
  reviews.forEach((review) => {
    const tree = treeMap.get(review.treeId)
    if (tree === undefined) return
    const owner = ownerAtDate(transfers, review.treeId, tree, review.date)
    map.set(owner, (map.get(owner) ?? 0) + 1)
  })
  return Array.from(map.entries())
    .map(([owner, reviewCount]) => ({ owner, reviewCount }))
    .sort((a, b) => b.reviewCount - a.reviewCount || a.owner.localeCompare(b.owner, 'zh-Hans-CN'))
}

/* ------------------------------ 逐株对账 ------------------------------ */

/**
 * 单条移交清册的对账状态（依据两侧归档留存与清册状态）。
 * - 已挂起 → 挂起待核
 * - 两侧清册都留存 → 一致
 * - 仅一侧留存 → 该侧独有（对不上，需挂起核对）
 */
export function deriveReconcileState(
  status: TransferStatus,
  fromArchived: boolean,
  toArchived: boolean
): Transfer['reconcile'] {
  if (status === '已挂起') return '挂起待核'
  if (fromArchived && toArchived) return '一致'
  if (fromArchived) return '仅原单位有'
  if (toArchived) return '仅新单位有'
  return '挂起待核'
}

export interface ReconcileRow {
  /** 古树编号（对账键） */
  code: string
  treeId: string
  /** 原单位侧清册是否在册 */
  fromSide: boolean
  /** 新单位侧清册是否在册 */
  toSide: boolean
  /** 是否已人工挂起 */
  suspended: boolean
  state: Transfer['reconcile']
}

/**
 * 逐株对账：每一册待确认移交记录按古树编号核对两侧清册留存。
 * 已确认的清册不再纳入对账（当时已核对通过）。
 * - 两侧清册都留存 → 一致
 * - 仅一侧留存 → 仅原单位有 / 仅新单位有（对不上）
 * - 状态为「已挂起」→ 挂起待核
 */
export function reconcileByCode(transfers: Transfer[]): ReconcileRow[] {
  return transfers
    .filter((row) => row.status !== '已确认')
    .map((row): ReconcileRow => {
      const state = deriveReconcileState(row.status, row.fromArchived, row.toArchived)
      return {
        code: row.treeCode,
        treeId: row.treeId,
        fromSide: row.fromArchived,
        toSide: row.toArchived,
        suspended: row.status === '已挂起',
        state,
      }
    })
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

/** 对账是否通过：没有任何「对不上」或「挂起待核」的条目 */
export function reconcileAllMatched(rows: ReconcileRow[]): boolean {
  return rows.every((row) => row.state === '一致')
}

/* --------------------------- 按侧重试（本侧重试） --------------------------- */

export interface RetryResult {
  side: TransferSide
  ok: boolean
  message: string
}

/**
 * 移交某一侧出错时只重试本侧，不影响另一侧。
 * 这里以可注入的 sideTask 模拟单侧提交，保证重试范围严格限定在出错侧。
 */
export async function retryTransferSide(
  _transfer: Transfer,
  side: TransferSide,
  sideTask: (side: TransferSide) => Promise<void>
): Promise<RetryResult> {
  try {
    await sideTask(side)
    return { side, ok: true, message: `${side === 'from' ? '原单位' : '新单位'}侧重试成功` }
  } catch (err) {
    return {
      side,
      ok: false,
      message: `${side === 'from' ? '原单位' : '新单位'}侧重试失败：${
        err instanceof Error ? err.message : '未知错误'
      }（仅重试本侧，另一侧不受影响）`,
    }
  }
}

/* ---------------------- 交接后子记录归属（检查/措施/加固） ---------------------- */

export interface HandoverScopedRows {
  /** 归原单位（交接日之前） */
  fromOwner: string
  /** 归新单位（交接日及以后） */
  toOwner: string
  surveys: Survey[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
}

/** 把某株古树的子记录按交接日拆成「原单位段 / 新单位段」 */
export function splitRowsByHandover(
  transfer: Transfer,
  surveys: Survey[],
  measures: Measure[],
  supports: Support[],
  reviews: Review[]
): { before: HandoverScopedRows; after: HandoverScopedRows } {
  const isAfter = (date: string): boolean => belongsToNewUnit(date, transfer.handoverDate)
  const pick = <T extends { treeId: string }>(list: T[]): T[] =>
    list.filter((row) => row.treeId === transfer.treeId)
  return {
    before: {
      fromOwner: transfer.fromOwner,
      toOwner: transfer.toOwner,
      surveys: pick(surveys).filter((r) => !isAfter(r.date)),
      measures: pick(measures).filter((r) => !isAfter(r.date)),
      supports: pick(supports).filter((r) => !isAfter(r.installDate)),
      reviews: pick(reviews).filter((r) => !isAfter(r.date)),
    },
    after: {
      fromOwner: transfer.fromOwner,
      toOwner: transfer.toOwner,
      surveys: pick(surveys).filter((r) => isAfter(r.date)),
      measures: pick(measures).filter((r) => isAfter(r.date)),
      supports: pick(supports).filter((r) => isAfter(r.installDate)),
      reviews: pick(reviews).filter((r) => isAfter(r.date)),
    },
  }
}
