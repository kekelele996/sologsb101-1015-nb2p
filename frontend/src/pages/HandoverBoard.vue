<script setup lang="ts">
/**
 * /handovers 管护责任移交
 * - 原单位把选定古树编入移交清册，新接手养护单位两侧逐株对账；
 * - 移交前定稿的复评结论仍算原单位，交接日后的检查 / 复壮 / 加固归新单位；
 * - 按古树编号逐株对账，对不上先挂起等核对；任一侧出错重传只重试本侧；
 * - 两侧核对一致后生效归属切换（部分生效），台账按现在归属统计、复评按当时归属统计。
 * 消费模型：Handover、OwnershipHistory、Tree、Review；复用组件：<StatBadge>、<EmptyPanel>。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type UploadFile } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useTreeStore } from '@/stores/treeStore'
import { useHandoverStore } from '@/stores/handoverStore'
import type { Handover, HandoverDraft, HandoverSide } from '@/types/handover'
import { HANDOVER_ITEM_STATUS_LABEL, SIDE_STATE_LABEL } from '@/types/handover'
import {
  belongsToNewUnit,
  buildManifest,
  parseManifest,
  reviewBelongsToOldUnit,
} from '@/utils/handover'
import { exportHandoverManifestFile } from '@/utils/export'
import { nowIso, today } from '@/utils/id'

const treeStore = useTreeStore()
const handoverStore = useHandoverStore()

onMounted(() => {
  void treeStore.loadAll()
  void handoverStore.init()
})

/* -------------------------------- 统计 -------------------------------- */

const effectiveCount = computed<number>(
  () =>
    handoverStore.handovers.reduce(
      (sum, handover) => sum + handover.items.filter((item) => item.status === '已生效').length,
      0
    )
)
const pendingCount = computed<number>(
  () =>
    handoverStore.handovers.reduce(
      (sum, handover) => sum + handover.items.filter((item) => item.status === '已挂起').length,
      0
    )
)
const reconcilingCount = computed<number>(
  () => handoverStore.handovers.filter((handover) => handover.status === '对账中' || handover.status === '部分生效').length
)
const ownerCount = computed<number>(() => Object.keys(handoverStore.currentOwnerCounts).length)

const statusTagType = (status: Handover['status']): 'info' | 'warning' | 'primary' | 'success' => {
  if (status === '草稿') return 'info'
  if (status === '对账中') return 'warning'
  if (status === '部分生效') return 'primary'
  return 'success'
}

const itemTagType = (status: keyof typeof HANDOVER_ITEM_STATUS_LABEL): 'info' | 'warning' | 'success' | 'danger' => {
  if (status === '待对账') return 'info'
  if (status === '已核对') return 'success'
  if (status === '已挂起') return 'danger'
  return 'success'
}

/* ------------------------------ 新建清册 ------------------------------ */

const createVisible = ref(false)
const submitting = ref(false)
const createFormRef = ref<FormInstance>()
const selectedTreeIds = ref<string[]>([])

const createForm = reactive<HandoverDraft>({
  fromOwner: '',
  toOwner: '',
  handoverDate: today(),
})

const createRules: FormRules<HandoverDraft> = {
  fromOwner: [{ required: true, message: '请填写原管护单位', trigger: 'blur' }],
  toOwner: [{ required: true, message: '请填写新接手养护单位', trigger: 'blur' }],
  handoverDate: [{ required: true, message: '请选择移交生效日', trigger: 'change' }],
}

const treeLabel = (treeId: string): string => {
  const tree = treeStore.trees.find((row) => row.id === treeId)
  return tree ? `${tree.code} ${tree.species}` : '（古树已删除）'
}

function openCreate(): void {
  selectedTreeIds.value = []
  Object.assign(createForm, {
    fromOwner: treeStore.currentTree?.owner ?? treeStore.trees[0]?.owner ?? '',
    toOwner: '',
    handoverDate: today(),
  })
  createVisible.value = true
}

async function handleCreate(): Promise<void> {
  if (createFormRef.value === undefined) return
  const valid = await createFormRef.value.validate().catch(() => false)
  if (!valid) return
  if (selectedTreeIds.value.length === 0) {
    ElMessage.warning('请勾选至少一株古树编入清册')
    return
  }
  if (createForm.fromOwner.trim() === createForm.toOwner.trim()) {
    ElMessage.warning('新接手养护单位不能与原管护单位相同')
    return
  }
  submitting.value = true
  try {
    const selectedTrees = treeStore.trees.filter((tree) => selectedTreeIds.value.includes(tree.id))
    const row = await handoverStore.createHandover(createForm, selectedTrees)
    if (row) {
      ElMessage.success(`清册 ${row.code} 已建册`)
      createVisible.value = false
      await openDetail(row.id)
    } else {
      ElMessage.warning(handoverStore.lastMessage)
    }
  } finally {
    submitting.value = false
  }
}

/* ------------------------------ 清册详情抽屉 ------------------------------ */

const detailVisible = ref(false)
const detailId = ref<string | null>(null)
const detail = computed<Handover | null>(
  () => handoverStore.handovers.find((row) => row.id === detailId.value) ?? null
)
const activeTab = ref<'reconcile' | 'history'>('reconcile')

const importingSide = ref<HandoverSide | null>(null)

async function openDetail(id: string, tab: 'reconcile' | 'history' = 'reconcile'): Promise<void> {
  await handoverStore.init()
  detailId.value = id
  activeTab.value = tab
  detailVisible.value = true
}

function closeDetail(): void {
  detailVisible.value = false
  detailId.value = null
}

function exportSide(side: HandoverSide): void {
  if (!detail.value) return
  const manifest = buildManifest(detail.value, side, nowIso())
  const filename = exportHandoverManifestFile(manifest)
  ElMessage.success(`已导出${side === 'from' ? '原单位档案室留存' : '新单位留存'}清册：${filename}`)
}

async function handleManifestUpload(file: File, side: HandoverSide): Promise<boolean> {
  if (!detail.value) return false
  importingSide.value = side
  try {
    const text = await file.text()
    const result = parseManifest(text)
    if (!result.ok || result.manifest === null) {
      ElMessage.error(result.message)
      return false
    }
    const manifest = result.manifest
    if (manifest.side !== side) {
      ElMessage.error(`文件是${manifest.side === 'from' ? '原单位' : '新单位'}侧片段，请导入到对应一侧（出错只重试本侧）。`)
      return false
    }
    if (manifest.handoverCode !== detail.value.code) {
      ElMessage.error(`清册编号不一致：文件为 ${manifest.handoverCode}，当前清册为 ${detail.value.code}`)
      return false
    }
    await handoverStore.importSideManifest(detail.value.id, side, manifest)
    ElMessage.success(handoverStore.lastMessage)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '读取清册片段失败')
  } finally {
    importingSide.value = null
  }
  return false
}

/** el-upload 回调适配：原单位侧 */
function onFromManifestChange(uploadFile: UploadFile): void {
  if (uploadFile.raw) void handleManifestUpload(uploadFile.raw, 'from')
}

/** el-upload 回调适配：新单位侧 */
function onToManifestChange(uploadFile: UploadFile): void {
  if (uploadFile.raw) void handleManifestUpload(uploadFile.raw, 'to')
}

/** 留存开关适配（el-switch change 事件不保证布尔类型，这里显式归一） */
function onFromArchiveChange(value: string | number | boolean): void {
  void toggleArchive('from', Boolean(value))
}

function onToArchiveChange(value: string | number | boolean): void {
  void toggleArchive('to', Boolean(value))
}

async function toggleArchive(side: HandoverSide, archived: boolean): Promise<void> {
  if (!detail.value) return
  await handoverStore.setArchived(detail.value.id, side, archived)
  ElMessage.success(archived ? `${side === 'from' ? '原单位档案室' : '新单位'}已留存本份清册` : '已撤销留存标记')
}

async function handleApply(): Promise<void> {
  if (!detail.value) return
  const ready = detail.value.items.filter((item) => item.status === '已核对').length
  const pending = detail.value.items.filter((item) => item.status === '已挂起').length
  try {
    await ElMessageBox.confirm(
      `确认把两侧核对一致的 ${ready} 株生效？生效后自 ${detail.value.handoverDate} 起管护归属转为「${detail.value.toOwner}」。` +
        (pending > 0 ? `\n另有 ${pending} 株挂起，本次不动，待核对后再生效。` : ''),
      '生效确认',
      { type: 'warning', confirmButtonText: '生效', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const count = await handoverStore.apply(detail.value.id)
  if (count > 0) ElMessage.success(`已生效 ${count} 株`)
  else ElMessage.warning(handoverStore.lastMessage)
}

const resolveVisible = ref(false)
const resolveTreeId = ref('')
const resolveNote = ref('')

function openResolve(treeId: string, existingNote: string): void {
  resolveTreeId.value = treeId
  resolveNote.value = existingNote
  resolveVisible.value = true
}

async function confirmResolve(): Promise<void> {
  if (!detail.value) return
  await handoverStore.resolvePending(detail.value.id, resolveTreeId.value, resolveNote.value)
  ElMessage.success('已解除挂起，将按两侧当前登记状态重新对账')
  resolveVisible.value = false
}

async function handleDelete(handover: Handover): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除清册 ${handover.code}？由该清册生成的归属履历段会一并移除（古树归属回到上一段），已写入的业务记录不受影响。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await handoverStore.deleteHandover(handover.id)
  if (detailId.value === handover.id) closeDetail()
  ElMessage.success('清册已删除')
}

/* ------------------------------ 责任边界预览 ------------------------------ */

interface BoundaryRow {
  kind: '树体检查' | '复壮措施' | '加固件' | '复评结论'
  date: string
  label: string
  side: '原单位' | '新单位'
}

const boundaryRows = computed<BoundaryRow[]>(() => {
  if (!detail.value) return []
  const handover = detail.value
  const treeIds = new Set(handover.items.map((item) => item.treeId))
  const rows: BoundaryRow[] = []
  treeStore.surveys
    .filter((row) => treeIds.has(row.treeId))
    .forEach((row) => {
      rows.push({
        kind: '树体检查',
        date: row.date,
        label: `${treeLabel(row.treeId)} 树高 ${row.heightM} m`,
        side: belongsToNewUnit(row.date, handover.handoverDate, 'survey') ? '新单位' : '原单位',
      })
    })
  treeStore.measures
    .filter((row) => treeIds.has(row.treeId))
    .forEach((row) => {
      rows.push({
        kind: '复壮措施',
        date: row.date,
        label: `${treeLabel(row.treeId)} ${row.type}（${row.state}）`,
        side: belongsToNewUnit(row.date, handover.handoverDate, 'measure') ? '新单位' : '原单位',
      })
    })
  treeStore.supports
    .filter((row) => treeIds.has(row.treeId))
    .forEach((row) => {
      rows.push({
        kind: '加固件',
        date: row.installDate,
        label: `${treeLabel(row.treeId)} ${row.type}`,
        side: belongsToNewUnit(row.installDate, handover.handoverDate, 'support') ? '新单位' : '原单位',
      })
    })
  treeStore.reviews
    .filter((row) => treeIds.has(row.treeId))
    .forEach((row) => {
      rows.push({
        kind: '复评结论',
        date: row.date,
        label: `${treeLabel(row.treeId)} ${row.vigor}：${row.conclusion.slice(0, 18)}…`,
        // 移交前定稿的复评结论仍算原单位
        side: reviewBelongsToOldUnit(row.date, handover.handoverDate) ? '原单位' : '新单位',
      })
    })
  return rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30)
})

/* ------------------------------ 归属履历视图 ------------------------------ */

const detailOwnership = computed(() => {
  if (!detail.value) return []
  const treeIds = new Set(detail.value.items.map((item) => item.treeId))
  return handoverStore.ownershipHistory
    .filter((segment) => treeIds.has(segment.treeId))
    .sort((a, b) => a.treeId.localeCompare(b.treeId) || b.fromDate.localeCompare(a.fromDate))
})

/** 台账按现在归属统计 */
const ownerStatRows = computed(() =>
  Object.entries(handoverStore.currentOwnerCounts)
    .map(([owner, count]) => ({ owner, count }))
    .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner, 'zh-Hans-CN'))
)

/** 复评结论按当时归属统计 */
const reviewStatRows = computed(() =>
  Object.entries(handoverStore.reviewStatsByOwner)
    .map(([owner, stat]) => ({ owner, ...stat }))
    .sort((a, b) => b.reviewCount - a.reviewCount || a.owner.localeCompare(b.owner, 'zh-Hans-CN'))
)
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="移交清册" :value="handoverStore.handovers.length" suffix="册" tone="primary" icon="Files" />
      <StatBadge
        label="已生效株数"
        :value="effectiveCount"
        suffix="株"
        tone="success"
        icon="CircleCheck"
        hint="两侧逐株核对一致并完成归属切换的古树"
      />
      <StatBadge
        label="挂起待核对"
        :value="pendingCount"
        suffix="株"
        :tone="pendingCount > 0 ? 'danger' : 'default'"
        icon="Warning"
        hint="按古树编号对不上的先挂起，不阻断其余株数生效"
      />
      <StatBadge label="对账中批次" :value="reconcilingCount" suffix="册" tone="warning" icon="RefreshRight" />
      <StatBadge label="当前管护单位" :value="ownerCount" suffix="个" tone="info" icon="OfficeBuilding" />
    </div>

    <el-alert
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      title="责任划分：以移交生效日 0 时为界"
      description="移交前定稿的复评结论仍算原管护单位；交接日（含）之后的树体检查、复壮措施与加固件归新接手养护单位。台账管护株数按现在归属统计，复评结论按当时归属统计。两侧按古树编号逐株对账，对不上的先挂起等核对；任一侧重传清册片段只重试本侧。"
    />

    <el-card shadow="never" class="mb-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">归属统计</span>
          <span class="card-header__hint">履历为统计真相来源（开口段 = 当前归属；命中日期所在段 = 当时归属）</span>
        </div>
      </template>
      <el-row :gutter="16">
        <el-col :xs="24" :sm="12">
          <div class="stat-block">
            <div class="stat-block__title">台账 · 按现在归属统计管护株数</div>
            <div v-if="ownerStatRows.length === 0" class="stat-block__empty">暂无归属数据</div>
            <div v-for="row in ownerStatRows" :key="row.owner" class="stat-block__row">
              <span class="stat-block__name">{{ row.owner }}</span>
              <el-tag type="success" effect="light">{{ row.count }} 株</el-tag>
            </div>
          </div>
        </el-col>
        <el-col :xs="24" :sm="12">
          <div class="stat-block">
            <div class="stat-block__title">复评结论 · 按当时归属统计</div>
            <div v-if="reviewStatRows.length === 0" class="stat-block__empty">暂无复评记录</div>
            <div v-for="row in reviewStatRows" :key="row.owner" class="stat-block__row">
              <span class="stat-block__name">{{ row.owner }}</span>
              <el-tag type="info" effect="light">结论 {{ row.reviewCount}} 条 · {{ row.treeCount }} 株</el-tag>
            </div>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">移交清册</span>
          <el-button type="primary" :disabled="treeStore.trees.length === 0" @click="openCreate">
            <el-icon><Plus /></el-icon>
            <span>新建移交清册</span>
          </el-button>
        </div>
      </template>

      <EmptyPanel
        v-if="handoverStore.handovers.length === 0 && !handoverStore.loading"
        title="还没有管护责任移交清册"
        description="把原单位的古树逐株编入清册，导出原单位档案室留存份；新接手养护单位导入自己那份后按古树编号逐株对账，核对一致再生效归属切换。"
        action-text="新建第一册移交清册"
        @action="openCreate"
      />

      <el-table v-else v-loading="handoverStore.loading" :data="handoverStore.handovers" row-key="id" stripe>
        <el-table-column prop="code" label="清册编号" width="160" />
        <el-table-column label="原管护单位" min-width="180">
          <template #default="{ row }">{{ row.fromOwner }}</template>
        </el-table-column>
        <el-table-column label="新接手养护单位" min-width="180">
          <template #default="{ row }">
            <span class="cell-new">{{ row.toOwner }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="handoverDate" label="生效日" width="115" />
        <el-table-column label="株数 / 状态" width="200">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>
                共 {{ row.items.length }} 株 · 已生效
                {{ row.items.filter((i: Handover['items'][number]) => i.status === '已生效').length }}
                · 挂起 {{ row.items.filter((i: Handover['items'][number]) => i.status === '已挂起').length }}
              </span>
              <el-tag size="small" :type="statusTagType(row.status)">{{ row.status }}</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="两侧留存" width="150">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-tag size="small" :type="row.archivedFrom ? 'success' : 'info'" effect="plain">原单位{{ row.archivedFrom ? '已留存' : '未留存' }}</el-tag>
              <el-tag size="small" :type="row.archivedTo ? 'success' : 'info'" effect="plain">新单位{{ row.archivedTo ? '已留存' : '未留存' }}</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openDetail(row.id)">对账 / 详情</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新建清册 -->
    <el-dialog v-model="createVisible" title="新建管护责任移交清册" width="640px">
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="140px">
        <el-form-item label="原管护单位" prop="fromOwner">
          <el-input v-model="createForm.fromOwner" placeholder="移交责任的原单位" />
        </el-form-item>
        <el-form-item label="新接手养护单位" prop="toOwner">
          <el-input v-model="createForm.toOwner" placeholder="交接后负责管护的养护单位" />
        </el-form-item>
        <el-form-item label="移交生效日" prop="handoverDate">
          <el-date-picker v-model="createForm.handoverDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="编入清册古树">
          <el-select
            v-model="selectedTreeIds"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            placeholder="按株勾选（可跨原管护单位）"
            style="width: 100%"
          >
            <el-option
              v-for="tree in treeStore.trees"
              :key="tree.id"
              :value="tree.id"
              :label="`${tree.code} · ${tree.species} · ${tree.owner}`"
            />
          </el-select>
        </el-form-item>
        <el-alert
          type="warning"
          show-icon
          :closable="false"
          title="生效日是责任分界点"
          description="生效日之前定稿的复评结论仍算原单位；生效日（含）之后的树体检查、复壮措施、加固件归新单位。建册后需两侧逐株对账一致才会生效归属切换。"
        />
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleCreate">建册并去对账</el-button>
      </template>
    </el-dialog>

    <!-- 清册详情抽屉 -->
    <el-drawer
      v-model="detailVisible"
      :title="detail ? `移交清册 ${detail.code}` : '移交清册'"
      size="72%"
      destroy-on-close
      @close="closeDetail"
    >
      <template v-if="detail">
        <el-descriptions :column="3" border size="small" class="mb-14">
          <el-descriptions-item label="原管护单位">{{ detail.fromOwner }}</el-descriptions-item>
          <el-descriptions-item label="新接手养护单位">
            <span class="cell-new">{{ detail.toOwner }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="移交生效日">{{ detail.handoverDate }}</el-descriptions-item>
          <el-descriptions-item label="批次状态">
            <el-tag :type="statusTagType(detail.status)">{{ detail.status }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="原单位档案留存">
            <el-switch
              :model-value="detail.archivedFrom"
              active-text="已留存"
              inactive-text="未留存"
              @change="onFromArchiveChange"
            />
          </el-descriptions-item>
          <el-descriptions-item label="新单位档案留存">
            <el-switch
              :model-value="detail.archivedTo"
              active-text="已留存"
              inactive-text="未留存"
              @change="onToArchiveChange"
            />
          </el-descriptions-item>
        </el-descriptions>

        <el-tabs v-model="activeTab">
          <el-tab-pane label="逐株对账" name="reconcile">
            <el-row :gutter="12" class="mb-14">
              <el-col :xs="24" :sm="12">
                <el-card shadow="hover" class="side-card">
                  <div class="side-card__head">
                    <span class="side-card__title">原单位侧（档案室留存这份）</span>
                    <el-tag size="small" :type="detail.archivedFrom ? 'success' : 'info'">
                      {{ detail.fromSideImportedAt ? '已重传/登记' : '未登记' }}
                    </el-tag>
                  </div>
                  <div class="side-card__actions">
                    <el-button size="small" @click="exportSide('from')">
                      <el-icon><Download /></el-icon>导出原单位份
                    </el-button>
                    <el-upload
                      :show-file-list="false"
                      :auto-upload="false"
                      accept="application/json,.json"
                      :on-change="onFromManifestChange"
                    >
                      <el-button size="small" :loading="importingSide === 'from'">
                        <el-icon><Upload /></el-icon>重传 / 导入原单位份
                      </el-button>
                    </el-upload>
                  </div>
                  <p class="side-card__tip">原单位侧出错时只在此侧重传重试，不影响新单位侧已确认结果。</p>
                </el-card>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-card shadow="hover" class="side-card">
                  <div class="side-card__head">
                    <span class="side-card__title">新单位侧（新单位自管这份）</span>
                    <el-tag size="small" :type="detail.archivedTo ? 'success' : 'info'">
                      {{ detail.toSideImportedAt ? '已重传/登记' : '未登记' }}
                    </el-tag>
                  </div>
                  <div class="side-card__actions">
                    <el-button size="small" @click="exportSide('to')">
                      <el-icon><Download /></el-icon>导出新单位份
                    </el-button>
                    <el-upload
                      :show-file-list="false"
                      :auto-upload="false"
                      accept="application/json,.json"
                      :on-change="onToManifestChange"
                    >
                      <el-button size="small" :loading="importingSide === 'to'">
                        <el-icon><Upload /></el-icon>重传 / 导入新单位份
                      </el-button>
                    </el-upload>
                  </div>
                  <p class="side-card__tip">两侧按古树编号 + 校验和逐株比对；新单位侧缺编号或校验和不一致即挂起。</p>
                </el-card>
              </el-col>
            </el-row>

            <el-alert
              v-if="detail.items.some((i) => i.status === '已挂起')"
              type="error"
              show-icon
              :closable="false"
              class="mb-14"
              :title="`有 ${detail.items.filter((i) => i.status === '已挂起').length} 株对不上，已挂起等核对`"
              description="挂起株不参与本次生效，其余核对一致的株数可以先生效（部分生效）。核对完成后可解除挂起重新对账。"
            />

            <el-table :data="detail.items" row-key="treeId" size="small" stripe class="mb-14">
              <el-table-column label="古树编号" min-width="170">
                <template #default="{ row }">
                  <div class="cell-stack">
                    <strong>{{ row.code }}</strong>
                    <span class="cell-sub">{{ row.species }} · {{ row.protectLevel }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="原单位侧" width="110">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.fromState === '确认无误' ? 'success' : row.fromState === '已登记' ? 'danger' : 'info'">
                    {{ SIDE_STATE_LABEL[row.fromState as keyof typeof SIDE_STATE_LABEL] }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="新单位侧" width="110">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.toState === '确认无误' ? 'success' : row.toState === '已登记' ? 'danger' : 'info'">
                    {{ SIDE_STATE_LABEL[row.toState as keyof typeof SIDE_STATE_LABEL] }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="对账状态" width="130">
                <template #default="{ row }">
                  <el-tag size="small" :type="itemTagType(row.status)" :effect="row.status === '已生效' ? 'dark' : 'light'">
                    {{ HANDOVER_ITEM_STATUS_LABEL[row.status as keyof typeof HANDOVER_ITEM_STATUS_LABEL] }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="备注 / 挂起原因" min-width="200">
                <template #default="{ row }">
                  <span :class="{ 'cell-warn': row.status === '已挂起' }">{{ row.note || '—' }}</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="110" fixed="right">
                <template #default="{ row }">
                  <el-button
                    v-if="row.status === '已挂起'"
                    link
                    type="primary"
                    size="small"
                    @click="openResolve(row.treeId, row.note)"
                  >
                    核对解除
                  </el-button>
                  <span v-else class="cell-sub">—</span>
                </template>
              </el-table-column>
            </el-table>

            <div class="apply-bar">
              <span class="apply-bar__hint">
                可生效 {{ detail.items.filter((i) => i.status === '已核对').length }} 株 ·
                挂起 {{ detail.items.filter((i) => i.status === '已挂起').length }} 株 ·
                待另一侧 {{ detail.items.filter((i) => i.status === '待对账').length }} 株
              </span>
              <el-button
                type="success"
                :disabled="!detail.items.some((i) => i.status === '已核对')"
                @click="handleApply"
              >
                生效已核对株数
              </el-button>
            </div>
          </el-tab-pane>

          <el-tab-pane label="责任边界预览" name="boundary">
            <el-alert
              type="info"
              show-icon
              :closable="false"
              class="mb-14"
              :title="`以 ${detail.handoverDate} 0 时为界的责任归集（最近 30 条）`"
            />
            <el-table :data="boundaryRows" size="small" stripe max-height="480">
              <el-table-column prop="date" label="日期" width="115" />
              <el-table-column prop="kind" label="类型" width="100" />
              <el-table-column label="记录" min-width="260">
                <template #default="{ row }">{{ row.label }}</template>
              </el-table-column>
              <el-table-column label="责任归属" width="110">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.side === '新单位' ? 'success' : 'warning'">{{ row.side }}</el-tag>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="归属履历" name="history">
            <el-table :data="detailOwnership" size="small" stripe>
              <el-table-column label="古树" min-width="170">
                <template #default="{ row }">{{ treeLabel(row.treeId) }}</template>
              </el-table-column>
              <el-table-column prop="owner" label="管护单位" min-width="180" />
              <el-table-column label="归属区间" min-width="210">
                <template #default="{ row }">
                  {{ row.fromDate }} ~ {{ row.toDate === '' ? '至今' : row.toDate }}
                </template>
              </el-table-column>
              <el-table-column prop="source" label="来源" width="110" />
              <el-table-column prop="note" label="备注" min-width="200" />
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </template>
    </el-drawer>

    <!-- 解除挂起 -->
    <el-dialog v-model="resolveVisible" title="核对解除挂起" width="480px" append-to-body>
      <p class="mb-14">双方线下核对清楚后，填写核对结论解除挂起，系统将按两侧当前登记状态重新判定。</p>
      <el-input v-model="resolveNote" type="textarea" :rows="3" placeholder="如：编号录入笔误，已与原单位档案室核对一致" />
      <template #footer>
        <el-button @click="resolveVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmResolve">确认解除</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #2f2a24;
}

.card-header__hint {
  font-size: 12px;
  color: #8c8479;
}

.stat-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 2px;
}

.stat-block__title {
  font-size: 13px;
  font-weight: 600;
  color: #4a5a30;
  margin-bottom: 2px;
}

.stat-block__empty {
  font-size: 13px;
  color: #a39a8c;
}

.stat-block__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  background: #fbfaf6;
  border: 1px solid #eee7da;
  border-radius: 8px;
}

.stat-block__name {
  font-size: 13px;
  color: #2f2a24;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.cell-new {
  color: #1e8449;
  font-weight: 600;
}

.cell-warn {
  color: #c0392b;
  font-weight: 600;
}

.side-card :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.side-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.side-card__title {
  font-size: 14px;
  font-weight: 600;
  color: #2f2a24;
}

.side-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.side-card__tip {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: #8c8479;
}

.apply-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 14px;
  background: #f6f8f2;
  border: 1px solid #dfe7d3;
  border-radius: 10px;
}

.apply-bar__hint {
  font-size: 13px;
  color: #4a5a30;
}
</style>
