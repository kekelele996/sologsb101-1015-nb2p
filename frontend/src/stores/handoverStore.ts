/**
 * 管护责任移交状态管理（Pinia）
 * 维护移交清册列表与归属履历；逐株对账、两侧独立重试、部分生效均落在此层。
 * 规则来源：types/handover.ts 与 utils/handover.ts（纯函数），本 store 只做编排与落库。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Tree } from '../types/tree'
import type { OwnershipHistory } from '../types/ownership'
import type {
  Handover,
  HandoverDraft,
  HandoverManifest,
  HandoverSide,
} from '../types/handover'
import {
  applyHandover,
  db,
  getHandover,
  initDatabase,
  listHandovers,
  putHandover,
  removeHandover,
} from '../utils/db'
import { nowIso, uuid } from '../utils/id'
import {
  buildItem,
  deriveBatchStatus,
  itemChecksum,
  reconcileManifest,
} from '../utils/handover'
import { useTreeStore } from './treeStore'

export const useHandoverStore = defineStore('handover', () => {
  const handovers = ref<Handover[]>([])
  const ownershipHistory = ref<OwnershipHistory[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)

  /** 当前归属：treeId → owner（取开口履历段中 fromDate 最新的一段） */
  const currentOwnerMap = computed<Record<string, string>>(() => {
    const result: Record<string, string> = {}
    ownershipHistory.value
      .filter((segment) => segment.toDate === '')
      .sort((a, b) => a.fromDate.localeCompare(b.fromDate))
      .forEach((segment) => {
        result[segment.treeId] = segment.owner
      })
    return result
  })

  /** 台账：管护单位 → 当前在管株数（按现在归属统计） */
  const currentOwnerCounts = computed<Record<string, number>>(() => {
    const treeStore = useTreeStore()
    const result: Record<string, number> = {}
    treeStore.trees.forEach((tree) => {
      const owner = currentOwnerMap.value[tree.id] ?? tree.owner
      if (owner === '') return
      result[owner] = (result[owner] ?? 0) + 1
    })
    return result
  })

  /** 复评结论：管护单位 → 条数（按复评当时归属统计） */
  const reviewStatsByOwner = computed<Record<string, { reviewCount: number; treeCount: number }>>(() => {
    const treeStore = useTreeStore()
    const result: Record<string, { reviewCount: number; treeCount: number }> = {}
    const treeSets: Record<string, Set<string>> = {}
    treeStore.reviews.forEach((review) => {
      const tree = treeStore.trees.find((row) => row.id === review.treeId)
      const segments = ownershipHistory.value
        .filter((segment) => segment.treeId === review.treeId)
        .sort((a, b) => a.fromDate.localeCompare(b.fromDate))
      const hit = segments.find(
        (segment) => segment.fromDate <= review.date && (segment.toDate === '' || segment.toDate > review.date)
      )
      const owner = hit?.owner ?? tree?.owner ?? '归属待核对'
      result[owner] ??= { reviewCount: 0, treeCount: 0 }
      treeSets[owner] ??= new Set<string>()
      result[owner].reviewCount += 1
      treeSets[owner].add(review.treeId)
    })
    Object.keys(result).forEach((owner) => {
      result[owner].treeCount = treeSets[owner].size
    })
    return result
  })

  async function init(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      const [rows, segments] = await Promise.all([listHandovers(), db.ownershipHistory.toArray()])
      handovers.value = rows
      ownershipHistory.value = segments.sort(
        (a, b) => a.treeId.localeCompare(b.treeId) || a.fromDate.localeCompare(b.fromDate)
      )
      ready.value = true
      revision.value += 1
    } catch (err) {
      error.value = err instanceof Error ? err.message : '读取移交数据失败'
    } finally {
      loading.value = false
    }
  }

  /** 生成清册编号 YJ-YYYYMMDD-序号 */
  function nextHandoverCode(date: string): string {
    const compact = date.replace(/-/g, '')
    const sameDay = handovers.value.filter((row) => row.code.includes(compact)).length
    return `YJ-${compact}-${String(sameDay + 1).padStart(3, '0')}`
  }

  /** 建清册（草稿）：选定古树逐株成行，原单位侧默认已确认，新单位侧待登记 */
  async function createHandover(
    draft: HandoverDraft,
    selectedTrees: Tree[]
  ): Promise<Handover | null> {
    if (selectedTrees.length === 0) {
      lastMessage.value = '请至少选择一株古树编入清册'
      return null
    }
    if (draft.toOwner.trim() === '' || draft.fromOwner.trim() === '') {
      lastMessage.value = '请填写原管护单位与新接手养护单位'
      return null
    }
    const stamp = nowIso()
    const row: Handover = {
      id: uuid('handover'),
      code: nextHandoverCode(draft.handoverDate),
      fromOwner: draft.fromOwner.trim(),
      toOwner: draft.toOwner.trim(),
      handoverDate: draft.handoverDate,
      status: '草稿',
      items: selectedTrees.map((tree) => buildItem(tree, draft.handoverDate)),
      archivedFrom: false,
      archivedTo: false,
      fromSideImportedAt: '',
      toSideImportedAt: '',
      reconciledAt: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    }
    await putHandover(row)
    lastMessage.value = `清册 ${row.code} 已建册，共 ${row.items.length} 株，等待两侧对账`
    await init()
    return row
  }

  /** 更新清册头（生效日变化会重算逐株校验和） */
  async function updateHandoverMeta(id: string, patch: Partial<Pick<Handover, 'fromOwner' | 'toOwner' | 'handoverDate'>>): Promise<void> {
    const existing = await getHandover(id)
    if (!existing) return
    const dateChanged = patch.handoverDate !== undefined && patch.handoverDate !== existing.handoverDate
    const next: Handover = {
      ...existing,
      ...patch,
      items: dateChanged
        ? existing.items.map((item) => ({
            ...item,
            checksum: itemChecksum(item.code, item.species, item.protectLevel, patch.handoverDate as string),
          }))
        : existing.items,
    }
    next.status = deriveBatchStatus(next)
    await putHandover(next)
    await init()
  }

  /**
   * 导入某一侧清册片段并对账。
   * 仅重算本侧：另一侧的已确认状态不受影响（「移交那侧出错只重试本侧」）。
   */
  async function importSideManifest(handoverId: string, side: HandoverSide, manifest: HandoverManifest): Promise<void> {
    const existing = await getHandover(handoverId)
    if (!existing) return
    const outcome = reconcileManifest(existing, side, manifest)
    const stamp = nowIso()
    const next: Handover = {
      ...existing,
      items: outcome.items,
      ...(side === 'from'
        ? { fromSideImportedAt: stamp, archivedFrom: true }
        : { toSideImportedAt: stamp, archivedTo: true }),
      reconciledAt: stamp,
    }
    next.status = deriveBatchStatus(next)
    await putHandover(next)
    lastMessage.value = `${side === 'from' ? '原单位' : '新单位'}侧重传完成：已核对 ${outcome.matched} 株，挂起 ${outcome.pending} 株，待另一侧登记 ${outcome.waiting} 株`
    await init()
  }

  /** 标记档案室留存（原单位 / 新单位各留各的） */
  async function setArchived(handoverId: string, side: HandoverSide, archived: boolean): Promise<void> {
    const existing = await getHandover(handoverId)
    if (!existing) return
    await putHandover({
      ...existing,
      ...(side === 'from' ? { archivedFrom: archived } : { archivedTo: archived }),
    })
    await init()
  }

  /** 手工把挂起株解除挂起（核对完成后重新判为待对账/已核对由两侧状态决定） */
  async function resolvePending(handoverId: string, treeId: string, note: string): Promise<void> {
    const existing = await getHandover(handoverId)
    if (!existing) return
    const items = existing.items.map((item): Handover['items'][number] => {
      if (item.treeId !== treeId) return item
      let status: Handover['items'][number]['status'] = '待对账'
      if (item.fromState === '确认无误' && item.toState === '确认无误') status = '已核对'
      return { ...item, status, note: note.trim() }
    })
    const next = { ...existing, items }
    next.status = deriveBatchStatus(next)
    await putHandover(next)
    await init()
  }

  /** 两侧已核对株数生效归属切换；挂起株留待核对（部分生效） */
  async function apply(handoverId: string): Promise<number> {
    const existing = await getHandover(handoverId)
    if (!existing) return 0
    const count = await applyHandover(existing, deriveBatchStatus)
    lastMessage.value = count > 0 ? `已生效 ${count} 株，管护归属与古树 owner 已同步` : '没有两侧核对一致的株数可生效'
    await init()
    await useTreeStore().loadAll()
    return count
  }

  async function deleteHandover(handoverId: string): Promise<void> {
    await removeHandover(handoverId)
    await init()
  }

  function ownerOfTreeAt(treeId: string, date: string): string {
    const hit = ownershipHistory.value
      .filter((segment) => segment.treeId === treeId && segment.fromDate <= date && (segment.toDate === '' || segment.toDate > date))
      .sort((a, b) => b.fromDate.localeCompare(a.fromDate))[0]
    return hit?.owner ?? ''
  }

  return {
    handovers,
    ownershipHistory,
    loading,
    ready,
    error,
    lastMessage,
    revision,
    currentOwnerMap,
    currentOwnerCounts,
    reviewStatsByOwner,
    init,
    nextHandoverCode,
    createHandover,
    updateHandoverMeta,
    importSideManifest,
    setArchived,
    resolvePending,
    apply,
    deleteHandover,
    ownerOfTreeAt,
  }
})
