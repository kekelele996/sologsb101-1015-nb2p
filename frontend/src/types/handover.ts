/**
 * 管护责任移交清册（Handover）
 * 原管护单位把选定古树的管护责任移交给新接手养护单位。
 *
 * 责任划分（以生效日 handoverDate 为界）：
 * - 移交前定稿的复评结论仍算原单位；交接日后的树体检查、复壮措施与加固件归新单位。
 * - 原单位档案室留存移交清册（fromSide 存档状态），新单位管自己那份（toSide 存档状态）。
 *
 * 逐株对账：两侧分别导出/导入清册片段，按古树编号逐株比对校验和，
 * 对不上的先挂起（pending）等核对，不阻断其余株数生效。
 * 任一侧重传文件只重试本侧，不影响另一侧已确认结果。
 */

/** 移交批次状态 */
export type HandoverStatus = '草稿' | '对账中' | '部分生效' | '已完成'

export const HANDOVER_STATUS_OPTIONS: HandoverStatus[] = ['草稿', '对账中', '部分生效', '已完成']

/** 清册内单株行的对账状态 */
export type HandoverItemStatus =
  | '待对账'
  | '已核对'
  | '已挂起'
  | '已生效'

export const HANDOVER_ITEM_STATUS_LABEL: Record<HandoverItemStatus, string> = {
  待对账: '待对账',
  已核对: '已核对',
  已挂起: '已挂起（待核对）',
  已生效: '已生效',
}

/** 一侧（原单位 / 新单位）的存档与对账状态 */
export type SideState = '未登记' | '已登记' | '确认无误'

export const SIDE_STATE_LABEL: Record<SideState, string> = {
  未登记: '未登记',
  已登记: '已登记',
  确认无误: '确认无误',
}

/**
 * 清册中的单株行。
 * 校验和由古树编号 + 树种 + 保护级别 + 生效日算出（见 utils/handover.ts），
 * 两侧各自导入清册片段后据此逐株对账。
 */
export interface HandoverItem {
  /** 古树 id */
  treeId: string
  /** 古树编号（对账以编号为准） */
  code: string
  /** 树种（校验和因子，防止同编号档案被串换） */
  species: string
  /** 保护级别（校验和因子） */
  protectLevel: string
  /** 本行校验和 */
  checksum: string
  /** 原单位侧状态（原单位档案室留存） */
  fromState: SideState
  /** 新单位侧状态（新单位自管） */
  toState: SideState
  /** 逐株对账结果 */
  status: HandoverItemStatus
  /** 挂起原因 / 核对备注 */
  note: string
}

export interface Handover {
  id: string
  /** 清册编号，便于档案室检索，如 YJ-20261005-001 */
  code: string
  /** 原管护单位（移交方） */
  fromOwner: string
  /** 新接手养护单位（接收方） */
  toOwner: string
  /** 移交生效日 YYYY-MM-DD：责任划分与归属履历的分界点 */
  handoverDate: string
  /** 批次状态 */
  status: HandoverStatus
  /** 逐株清册行 */
  items: HandoverItem[]
  /** 原单位档案室是否已留存本清册 */
  archivedFrom: boolean
  /** 新单位是否已留存自己那份 */
  archivedTo: boolean
  /** 原单位侧最近一次清册片段导入时间（重试时刷新；'' 表示从未导入） */
  fromSideImportedAt: string
  /** 新单位侧最近一次清册片段导入时间 */
  toSideImportedAt: string
  /** 最近一次对账时间 */
  reconciledAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建移交清册的表单草稿 */
export interface HandoverDraft {
  fromOwner: string
  toOwner: string
  handoverDate: string
}

/** 对账的一侧 */
export type HandoverSide = 'from' | 'to'

/** 导入清册片段中的单行（交换文件格式） */
export interface HandoverManifestEntry {
  code: string
  species: string
  protectLevel: string
  checksum: string
}

/** 导出的清册片段（交换文件）：原单位与新单位各持一份 */
export interface HandoverManifest {
  /** 固定标识，防止误导入其他系统文件 */
  kind: 'gb-tree-handover-manifest'
  handoverCode: string
  /** 出口侧：from = 原单位档案室那份，to = 新单位那份 */
  side: HandoverSide
  fromOwner: string
  toOwner: string
  handoverDate: string
  exportedAt: string
  entries: HandoverManifestEntry[]
}
