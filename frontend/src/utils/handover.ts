/**
 * 管护责任移交领域规则（纯函数）
 *
 * 责任划分边界（移交生效日 handoverDate，当日 0 时起算）：
 * - 复评结论：移交生效日之前定稿的仍算原管护单位；
 * - 树体检查 / 复壮措施 / 加固件：交接日（含当日）之后发生的归新接手养护单位。
 *
 * 归属履历 ownershipHistory 是上述规则落地后的唯一真相来源：
 * 每段区间 [fromDate, toDate) 对应一个管护单位，toDate 为空表示至今。
 * - 台账管护株数 = 按「现在归属」（开口段）统计；
 * - 复评结论 = 按「当时归属」（复评日期落在哪个区间）统计。
 *
 * 两侧对账：原单位（from）与新单位（to）各自导入清册片段，
 * 按古树编号逐株比对校验和；对不上的先挂起等核对。
 * 任一侧重传只重试本侧，不改动另一侧已确认状态。
 */
import type { OwnershipHistory } from '../types/ownership'
import type {
  Handover,
  HandoverItem,
  HandoverManifest,
  HandoverSide,
  HandoverStatus,
  SideState,
} from '../types/handover'
import type { Review } from '../types/review'
import type { Tree } from '../types/tree'

/** 责任边界上的业务类型 */
export type BoundaryKind = 'review' | 'survey' | 'measure' | 'support'

/**
 * 业务记录是否归新接手养护单位。
 * 统一以移交生效日 0 时为界（date >= handoverDate 即交接日后）：
 * - 复评结论在生效日之前定稿的算原单位（参见 {@link reviewBelongsToOldUnit}）；
 * - 树体检查 / 复壮措施 / 加固件在交接日（含）之后发生的归新单位。
 */
export function belongsToNewUnit(date: string, handoverDate: string, kind: BoundaryKind): boolean {
  void kind
  return date >= handoverDate
}

/** 复评结论是否仍算原单位（移交前定稿） */
export function reviewBelongsToOldUnit(date: string, handoverDate: string): boolean {
  return date < handoverDate
}

/* ------------------------------- 校验和 ------------------------------- */

/** FNV-1a 32 位哈希，输出 8 位十六进制；纯本地计算，无外部依赖 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 清册逐株校验和：古树编号 + 树种 + 保护级别 + 移交生效日。
 * 两侧各自算出的值一致才视为「同株同档」，防止编号相同但档案内容被串换。
 */
export function itemChecksum(code: string, species: string, protectLevel: string, handoverDate: string): string {
  const normalized = [code, species, protectLevel, handoverDate]
    .map((part) => part.trim())
    .join('|')
    .normalize('NFKC')
  return fnv1aHex(normalized)
}

/* ----------------------------- 归属履历查询 ----------------------------- */

/** 某株古树在指定日期的管护单位；日期为空或无命中时返回空串 */
export function ownerAtDate(history: OwnershipHistory[], treeId: string, date: string): string {
  if (date === '') return ''
  const segments = history
    .filter((row) => row.treeId === treeId && row.fromDate <= date && (row.toDate === '' || row.toDate > date))
    .sort((a, b) => b.fromDate.localeCompare(a.fromDate))
  return segments[0]?.owner ?? ''
}

/** 某株古树的当前管护单位（开口段 toDate 为空） */
export function currentOwner(history: OwnershipHistory[], treeId: string): string {
  const open = history
    .filter((row) => row.treeId === treeId && row.toDate === '')
    .sort((a, b) => b.fromDate.localeCompare(a.fromDate))
  return open[0]?.owner ?? ''
}

/* -------------------------------- 统计 -------------------------------- */

/** 管护单位 → 当前在管株数（台账按现在归属统计） */
export function countTreesByCurrentOwner(trees: Tree[], history: OwnershipHistory[]): Record<string, number> {
  const result: Record<string, number> = {}
  trees.forEach((tree) => {
    const owner = currentOwner(history, tree.id) || tree.owner
    if (owner === '') return
    result[owner] = (result[owner] ?? 0) + 1
  })
  return result
}

export interface ReviewOwnerStat {
  /** 按复评当时归属统计的复评条数 */
  reviewCount: number
  /** 涉及古树株数（去重） */
  treeCount: number
}

/**
 * 管护单位 → 复评结论统计（复评结论按当时归属统计）。
 * 找不到归属区间的复评（理论上升级补录后不应出现）归入「归属待核对」。
 */
export function reviewStatsByOwnerAtTime(
  trees: Tree[],
  reviews: Review[],
  history: OwnershipHistory[]
): Record<string, ReviewOwnerStat> {
  const ownerOfTree = new Map(trees.map((tree) => [tree.id, tree]))
  const result: Record<string, ReviewOwnerStat> = {}
  const treeSets: Record<string, Set<string>> = {}
  reviews.forEach((review) => {
    const tree = ownerOfTree.get(review.treeId)
    const fallback = tree?.owner ?? ''
    const owner = ownerAtDate(history, review.treeId, review.date) || fallback || '归属待核对'
    result[owner] ??= { reviewCount: 0, treeCount: 0 }
    treeSets[owner] ??= new Set<string>()
    result[owner].reviewCount += 1
    treeSets[owner].add(review.treeId)
  })
  Object.keys(result).forEach((owner) => {
    result[owner].treeCount = treeSets[owner].size
  })
  return result
}

/* ------------------------------- 清册对账 ------------------------------- */

/** 生成清册内一行（含校验和），初始原单位侧已确认（清册由其编录），新单位侧待登记 */
export function buildItem(
  tree: Tree,
  handoverDate: string
): HandoverItem {
  return {
    treeId: tree.id,
    code: tree.code,
    species: tree.species,
    protectLevel: tree.protectLevel,
    checksum: itemChecksum(tree.code, tree.species, tree.protectLevel, handoverDate),
    fromState: '确认无误',
    toState: '未登记',
    status: '待对账',
    note: '',
  }
}

interface RecomputeResult {
  status: HandoverItem['status']
  reasons: string[]
}

/** 依据两侧登记状态重算单行对账状态；已生效行保持不变 */
function recomputeItemStatus(item: HandoverItem, sideImported: Record<HandoverSide, boolean>): RecomputeResult {
  if (item.status === '已生效') return { status: '已生效', reasons: [] }
  const reasons: string[] = []
  if (sideImported.from && item.fromState !== '确认无误') {
    reasons.push(item.fromState === '已登记' ? '原单位侧校验和不一致' : '原单位清册缺少该编号')
  }
  if (sideImported.to && item.toState !== '确认无误') {
    reasons.push(item.toState === '已登记' ? '新单位侧校验和不一致' : '新单位清册缺少该编号')
  }
  if (reasons.length > 0) return { status: '已挂起', reasons }
  if (item.fromState === '确认无误' && item.toState === '确认无误') return { status: '已核对', reasons: [] }
  return { status: '待对账', reasons: [] }
}

export interface ReconcileOutcome {
  /** 参与比对的株数（清册行数） */
  total: number
  /** 两侧一致、已核对的株数 */
  matched: number
  /** 挂起待核对的株数 */
  pending: number
  /** 仍待另一侧登记的株数 */
  waiting: number
  /** 已生效的株数 */
  effective: number
  items: HandoverItem[]
}

/**
 * 导入某一侧的清册片段并逐株对账。
 * 关键约束：只改动被导入侧（side）的状态，另一侧保持原样——
 * 移交那侧出错重传时，只重试本侧。
 */
export function reconcileManifest(handover: Handover, side: HandoverSide, manifest: HandoverManifest): ReconcileOutcome {
  const entries = new Map(manifest.entries.map((entry) => [entry.code.trim(), entry]))
  const items = handover.items.map((item) => {
    if (item.status === '已生效') return item
    const entry = entries.get(item.code.trim())
    let nextState: SideState
    let note = item.note
    if (!entry) {
      nextState = '未登记'
    } else if (
      entry.checksum.trim().toLowerCase() === item.checksum.toLowerCase() &&
      entry.species.trim() === item.species &&
      entry.protectLevel.trim() === item.protectLevel
    ) {
      nextState = '确认无误'
    } else {
      nextState = '已登记'
    }
    const next: HandoverItem = {
      ...item,
      [side === 'from' ? 'fromState' : 'toState']: nextState,
    }
    const sideImported: Record<HandoverSide, boolean> = {
      from: handover.fromSideImportedAt !== '' || side === 'from',
      to: handover.toSideImportedAt !== '' || side === 'to',
    }
    const { status, reasons } = recomputeItemStatus(next, sideImported)
    next.status = status
    if (status === '已挂起') {
      note = reasons.join('；')
    } else if (note.includes('原单位') || note.includes('新单位')) {
      note = ''
    }
    next.note = note
    return next
  })

  return {
    total: items.length,
    matched: items.filter((item) => item.status === '已核对').length,
    pending: items.filter((item) => item.status === '已挂起').length,
    waiting: items.filter((item) => item.status === '待对账').length,
    effective: items.filter((item) => item.status === '已生效').length,
    items,
  }
}

/** 由逐株状态与两侧登记时间派生批次状态 */
export function deriveBatchStatus(handover: Handover): HandoverStatus {
  const statuses = handover.items.map((item) => item.status)
  if (statuses.length > 0 && statuses.every((status) => status === '已生效')) return '已完成'
  if (statuses.includes('已生效')) return '部分生效'
  if (handover.fromSideImportedAt !== '' || handover.toSideImportedAt !== '') return '对账中'
  return '草稿'
}

/** 当前可生效（两侧已核对、尚未生效）的行 */
export function effectiveItems(handover: Handover): HandoverItem[] {
  return handover.items.filter((item) => item.status === '已核对')
}

/** 挂起待核对的行 */
export function pendingItems(handover: Handover): HandoverItem[] {
  return handover.items.filter((item) => item.status === '已挂起')
}

/* ----------------------------- 清册片段交换 ----------------------------- */

/** 导出某一侧（原单位档案室 / 新单位）的清册片段 */
export function buildManifest(handover: Handover, side: HandoverSide, exportedAt: string): HandoverManifest {
  return {
    kind: 'gb-tree-handover-manifest',
    handoverCode: handover.code,
    side,
    fromOwner: handover.fromOwner,
    toOwner: handover.toOwner,
    handoverDate: handover.handoverDate,
    exportedAt,
    entries: handover.items.map((item) => ({
      code: item.code,
      species: item.species,
      protectLevel: item.protectLevel,
      checksum: item.checksum,
    })),
  }
}

export interface ManifestParseResult {
  ok: boolean
  message: string
  manifest: HandoverManifest | null
}

/** 解析并校验清册片段 JSON（两侧交换文件格式） */
export function parseManifest(text: string): ManifestParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, message: 'JSON 解析失败，请确认清册片段文件完整。', manifest: null }
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '清册片段格式不正确：顶层必须是对象。', manifest: null }
  }
  const data = raw as Partial<HandoverManifest>
  if (data.kind !== 'gb-tree-handover-manifest') {
    return { ok: false, message: '不是本系统导出的移交清册片段（缺少 kind 标识）。', manifest: null }
  }
  if (data.side !== 'from' && data.side !== 'to') {
    return { ok: false, message: '清册片段缺少有效的 side 字段（from / to）。', manifest: null }
  }
  if (!Array.isArray(data.entries)) {
    return { ok: false, message: '清册片段缺少 entries 株数明细数组。', manifest: null }
  }
  return { ok: true, message: '清册片段校验通过。', manifest: data as HandoverManifest }
}
