/**
 * 管护责任移交（Transfer）
 * 古树名木管护责任由原单位移交至新接手的养护单位。
 *
 * 归属口径：
 * - 移交前定稿的复评结论仍算原单位；交接日之后的树体检查、复壮措施与加固件归新单位。
 * - 台账按现在归属（古树当前 owner）统计管护株数；复评结论按当时归属统计。
 * - 双方各留一份移交清册：原单位档案室留存一份，新单位留存自己那份。
 */

/** 移交状态：对账未通过的条目先挂起，核对清楚后再确认 */
export type TransferStatus = '待确认' | '已确认' | '已挂起'

export const TRANSFER_STATUS_OPTIONS: TransferStatus[] = ['待确认', '已确认', '已挂起']

/** 移交方向上一侧：from = 原单位侧，to = 新单位侧；失败重试只重试本侧 */
export type TransferSide = 'from' | 'to'

export const TRANSFER_SIDE_LABEL: Record<TransferSide, string> = {
  from: '原单位侧',
  to: '新单位侧',
}

/** 逐株对账结果：按古树编号核对两侧清册是否一致 */
export type ReconcileState = '一致' | '仅原单位有' | '仅新单位有' | '挂起待核'

export interface Transfer {
  id: string
  /** 移交清册编号，如 移-2026-0001 */
  code: string
  /** 移交古树 */
  treeId: string
  /** 古树编号快照（移交时点），逐株对账以编号为准 */
  treeCode: string
  /** 原管护单位（移交方） */
  fromOwner: string
  /** 新接手养护单位（接收方） */
  toOwner: string
  /** 交接日期 YYYY-MM-DD：责任与档案口径的分界日 */
  handoverDate: string
  /** 清册状态 */
  status: TransferStatus
  /** 原单位档案室是否留存清册 */
  fromArchived: boolean
  /** 新单位是否留存自己那份清册 */
  toArchived: boolean
  /** 两侧对账结果 */
  reconcile: ReconcileState
  /** 最近一次重试的一侧（移交侧出错只重试本侧） */
  lastRetrySide: TransferSide | ''
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建移交清册条目的表单草稿（清册编号 / 原单位由系统补齐） */
export interface TransferDraft {
  treeId: string
  /** 新接手养护单位 */
  toOwner: string
  /** 交接日期 */
  handoverDate: string
  /** 原单位档案室是否留存清册（该侧出错时可只重试本侧） */
  fromArchived: boolean
  /** 新单位是否留存自己那份清册 */
  toArchived: boolean
  note: string
}
