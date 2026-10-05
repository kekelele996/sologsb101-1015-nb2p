/**
 * 归属履历（OwnershipHistory）
 * 每段履历表示某株古树在 [fromDate, toDate) 区间内的管护责任归属。
 * - 当前归属：toDate 为空串的那一段（台账按现在归属统计管护株数）。
 * - 时点归属（复评结论按当时归属统计）：fromDate <= 目标日期 且 toDate 为空或晚于目标日期。
 * - 数据升级（v3）时，为已有古树按现有管护单位补一段履历，fromDate 取在档最早业务日期。
 */

export interface OwnershipHistory {
  id: string
  /** 所属古树 */
  treeId: string
  /** 管护单位（本段归属） */
  owner: string
  /** 归属起始日 YYYY-MM-DD（含当日） */
  fromDate: string
  /** 归属结束日 YYYY-MM-DD（不含当日，即移交生效日）；空串表示至今 */
  toDate: string
  /** 来源：升级补录 / 手工录入 / 移交清册（记录清册 id 便于追溯） */
  source: '升级补录' | '手工录入' | '移交清册'
  /** 关联的移交清册 id（source 为「移交清册」时必填） */
  handoverId: string
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}
