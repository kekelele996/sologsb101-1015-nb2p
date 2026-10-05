/**
 * 管护责任移交状态管理（Pinia）
 * 维护移交清册、两侧归档留存、逐株对账、挂起核对与本侧重试；
 * 台账按现在归属统计管护株数，复评结论按当时归属统计。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Transfer, TransferDraft, TransferSide, TransferStatus } from '../types/transfer'
import {
  confirmTransfer,
  createTransfer,
  getTransfer,
  listTransfers,
  removeTransfer,
  resumeTransfer,
  retryTransferSide,
  suspendTransfer,
} from '../utils/db'
import {
  countReviewsByOwnerAtTime,
  countTreesByCurrentOwner,
  ownerAtDate,
  reconcileByCode,
  type ReconcileRow,
} from '../utils/attribution'
import { today } from '../utils/id'
import { useTreeStore } from './treeStore'

/** 移交台账筛选条件 */
export interface TransferFilters {
  keyword: string
  status: TransferStatus | 'all'
  reconcile: Transfer['reconcile'] | 'all'
}

export const useTransferStore = defineStore('transfer', () => {
  const rows = ref<Transfer[]>([])
  const loading = ref(false)
  const lastMessage = ref('')
  const filters = reactive<TransferFilters>({ keyword: '', status: 'all', reconcile: 'all' })

  /** 两侧逐株对账结果（按古树编号） */
  const reconcileRows = computed<ReconcileRow[]>(() => reconcileByCode(rows.value))

  /** 对不上 / 挂起待核的条目数 */
  const pendingReconcileCount = computed<number>(
    () => reconcileRows.value.filter((row) => row.state !== '一致').length
  )

  /** 台账：按现在归属（古树当前 owner）统计管护株数 */
  const custodyByOwner = computed(() =>
    countTreesByCurrentOwner(useTreeStore().trees)
  )

  /** 复评结论：按当时归属统计（交接前算原单位，交接后算新单位） */
  const reviewsByOwner = computed(() => {
    const treeStore = useTreeStore()
    return countReviewsByOwnerAtTime(
      treeStore.trees,
      treeStore.reviews,
      rows.value,
      today()
    )
  })

  const visibleRows = computed<Transfer[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return rows.value.filter((row) => {
      if (filters.status !== 'all' && row.status !== filters.status) return false
      if (filters.reconcile !== 'all' && row.reconcile !== filters.reconcile) return false
      if (keyword === '') return true
      return (
        row.code.toLowerCase().includes(keyword) ||
        row.treeCode.toLowerCase().includes(keyword) ||
        row.fromOwner.toLowerCase().includes(keyword) ||
        row.toOwner.toLowerCase().includes(keyword)
      )
    })
  })

  /** 复评结论当时归属的单位名（供复评页展示口径） */
  function reviewOwnerOf(review: { treeId: string; date: string }): string {
    const treeStore = useTreeStore()
    const tree = treeStore.trees.find((item) => item.id === review.treeId)
    if (!tree) return '（古树已删除）'
    return ownerAtDate(rows.value, review.treeId, tree, review.date)
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      rows.value = await listTransfers()
      lastMessage.value = ''
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '读取移交清册失败'
    } finally {
      loading.value = false
    }
  }

  function setFilters(patch: Partial<TransferFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    filters.keyword = ''
    filters.status = 'all'
    filters.reconcile = 'all'
  }

  async function add(draft: TransferDraft): Promise<Transfer | null> {
    const treeStore = useTreeStore()
    const tree = treeStore.trees.find((item) => item.id === draft.treeId)
    if (!tree) {
      lastMessage.value = '请选择要移交的古树'
      return null
    }
    if (draft.toOwner.trim() === '') {
      lastMessage.value = '请填写新接手的养护单位'
      return null
    }
    if (draft.toOwner.trim() === tree.owner) {
      lastMessage.value = '新接手单位与原管护单位相同，无需移交'
      return null
    }
    if (draft.handoverDate === '') {
      lastMessage.value = '请选择交接日期'
      return null
    }
    const row = await createTransfer({
      tree,
      toOwner: draft.toOwner.trim(),
      handoverDate: draft.handoverDate,
      fromArchived: draft.fromArchived,
      toArchived: draft.toArchived,
      note: draft.note,
    })
    await load()
    lastMessage.value =
      row.reconcile === '一致'
        ? `已建立移交清册 ${row.code}，两侧清册齐备，可对账确认`
        : `已建立移交清册 ${row.code}，对账「${row.reconcile}」，缺失侧补留存后只重试本侧`
    return row
  }

  /** 确认移交：对账一致才生效，并切换古树当前管护单位、追加归属履历 */
  async function confirm(id: string): Promise<boolean> {
    try {
      await confirmTransfer(id)
      await load()
      await useTreeStore().loadAll()
      lastMessage.value = '移交已确认：管护责任转至新单位，归属履历已追加'
      return true
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '确认移交失败'
      return false
    }
  }

  async function suspend(id: string): Promise<void> {
    await suspendTransfer(id)
    await load()
    lastMessage.value = '该株已挂起，等两侧核对清楚后再处理'
  }

  async function resume(id: string): Promise<void> {
    await resumeTransfer(id)
    await load()
    lastMessage.value = '已恢复为待确认'
  }

  /** 某一侧出错只重试本侧 */
  async function retrySide(id: string, side: TransferSide): Promise<void> {
    const updated = await retryTransferSide(id, side)
    await load()
    if (updated) {
      lastMessage.value =
        side === 'from' ? '已重试原单位侧清册留存，新单位侧不受影响' : '已重试新单位侧清册留存，原单位侧不受影响'
    }
  }

  async function remove(id: string): Promise<void> {
    await removeTransfer(id)
    await load()
    lastMessage.value = '移交清册已删除'
  }

  async function getById(id: string): Promise<Transfer | undefined> {
    return getTransfer(id)
  }

  return {
    rows,
    loading,
    lastMessage,
    filters,
    visibleRows,
    reconcileRows,
    pendingReconcileCount,
    custodyByOwner,
    reviewsByOwner,
    load,
    setFilters,
    resetFilters,
    add,
    confirm,
    suspend,
    resume,
    retrySide,
    remove,
    getById,
    reviewOwnerOf,
  }
})
