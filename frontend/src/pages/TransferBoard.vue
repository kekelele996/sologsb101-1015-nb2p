<script setup lang="ts">
/**
 * /transfers 管护责任移交
 * 原单位 → 新接手养护单位的责任移交：建移交清册、两侧各留一份、按古树编号逐株对账，
 * 对不上先挂起等核对、某侧出错只重试本侧；台账按现在归属统计株数，复评结论按当时归属统计。
 * 消费模型：Transfer、Tree、Review；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ArrowDown } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useTransferStore } from '@/stores/transferStore'
import { useTreeStore } from '@/stores/treeStore'
import { TRANSFER_SIDE_LABEL, TRANSFER_STATUS_OPTIONS, type Transfer, type TransferDraft } from '@/types/transfer'
import { splitRowsByHandover } from '@/utils/attribution'
import { today } from '@/utils/id'

const transferStore = useTransferStore()
const treeStore = useTreeStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()
const detailId = ref<string | null>(null)

const form = reactive<TransferDraft>({
  treeId: '',
  toOwner: '',
  handoverDate: today(),
  fromArchived: true,
  toArchived: true,
  note: '',
})

const rules: FormRules<TransferDraft> = {
  treeId: [{ required: true, message: '请选择移交古树', trigger: 'change' }],
  toOwner: [{ required: true, message: '请填写新接手的养护单位', trigger: 'blur' }],
  handoverDate: [{ required: true, message: '请选择交接日期', trigger: 'change' }],
}

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

const rows = computed<Transfer[]>(() => transferStore.visibleRows)

const statusTagType = (status: Transfer['status']): 'warning' | 'success' | 'danger' =>
  status === '已确认' ? 'success' : status === '已挂起' ? 'danger' : 'warning'

const reconcileTagType = (
  state: Transfer['reconcile']
): 'success' | 'danger' | 'warning' | 'info' =>
  state === '一致' ? 'success' : state === '挂起待核' ? 'danger' : 'warning'

const detailRow = computed<Transfer | null>(
  () => transferStore.rows.find((row) => row.id === detailId.value) ?? null
)

const detailTree = computed(() =>
  detailRow.value ? treeStore.trees.find((tree) => tree.id === detailRow.value?.treeId) ?? null : null
)

/** 交接日前后子记录拆分：交接后检查 / 措施 / 加固归新单位 */
const detailScope = computed(() => {
  if (!detailRow.value) return null
  return splitRowsByHandover(
    detailRow.value,
    treeStore.surveys,
    treeStore.measures,
    treeStore.supports,
    treeStore.reviews
  )
})

const detailOpen = computed<boolean>({
  get: () => detailId.value !== null,
  set: (open) => {
    if (!open) detailId.value = null
  },
})

onMounted(() => {
  void treeStore.loadAll()
  void transferStore.load()
})

function openCreate(): void {
  Object.assign(form, {
    treeId: treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '',
    toOwner: '',
    handoverDate: today(),
    fromArchived: true,
    toArchived: true,
    note: '',
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const row = await transferStore.add({ ...form })
    if (row === null) {
      ElMessage.error(transferStore.lastMessage)
      return
    }
    ElMessage.success(`已建立移交清册 ${row.code}`)
    dialogVisible.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function handleConfirm(row: Transfer): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认「${row.treeCode}」由 ${row.fromOwner} 移交至 ${row.toOwner}？交接日 ${row.handoverDate} 后该株当前管护单位将切换为新单位（交接前定稿复评结论仍算原单位）。`,
      '确认管护责任移交',
      { type: 'warning', confirmButtonText: '确认移交', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const ok = await transferStore.confirm(row.id)
  if (ok) ElMessage.success('移交已确认')
  else ElMessage.error(transferStore.lastMessage)
}

async function handleSuspend(row: Transfer): Promise<void> {
  await transferStore.suspend(row.id)
  ElMessage.warning('已挂起，等两侧核对')
}

async function handleResume(row: Transfer): Promise<void> {
  await transferStore.resume(row.id)
  ElMessage.success('已恢复为待确认')
}

async function handleRetry(row: Transfer, side: 'from' | 'to'): Promise<void> {
  await transferStore.retrySide(row.id, side)
  ElMessage.success(transferStore.lastMessage)
}

async function handleDelete(row: Transfer): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除移交清册 ${row.code}？已确认的归属履历不会自动回退。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await transferStore.remove(row.id)
  ElMessage.success('移交清册已删除')
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'status') transferStore.setFilters({ status: value as Transfer['status'] | 'all' })
  if (key === 'reconcile') {
    transferStore.setFilters({ reconcile: value as Transfer['reconcile'] | 'all' })
  }
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="移交清册" :value="transferStore.rows.length" suffix="册" tone="primary" icon="Histogram" />
      <StatBadge
        label="待确认"
        :value="transferStore.rows.filter((r) => r.status === '待确认').length"
        suffix="册"
        tone="warning"
        icon="DataLine"
      />
      <StatBadge
        label="对账异常 / 挂起"
        :value="transferStore.pendingReconcileCount"
        suffix="株"
        :tone="transferStore.pendingReconcileCount > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="按古树编号逐株对账，仅一侧有或已挂起的条目数"
      />
      <StatBadge
        label="涉及古树"
        :value="new Set(transferStore.rows.map((r) => r.treeId)).size"
        suffix="株"
        tone="info"
        icon="PieChart"
      />
    </div>

    <el-alert
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      title="归属口径：移交前定稿的复评结论仍算原单位；交接后的树体检查、复壮措施与加固件归新单位"
      description="台账按现在归属（古树当前管护单位）统计管护株数；复评结论按当时归属统计。原单位档案室与新单位各留一份清册，按古树编号逐株对账，对不上先挂起；某一侧出错只重试本侧。"
    />

    <el-row :gutter="14" class="mb-14">
      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header><span class="card-header__title">台账 · 按现在归属统计管护株数</span></template>
          <el-table :data="transferStore.custodyByOwner" size="small" stripe>
            <el-table-column prop="owner" label="当前管护单位" min-width="200" />
            <el-table-column prop="treeCount" label="管护株数" width="110" align="right">
              <template #default="{ row }">{{ row.treeCount }} 株</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header><span class="card-header__title">复评结论 · 按当时归属统计</span></template>
          <el-table :data="transferStore.reviewsByOwner" size="small" stripe>
            <el-table-column prop="owner" label="结论归属单位" min-width="200" />
            <el-table-column prop="reviewCount" label="复评结论" width="110" align="right">
              <template #default="{ row }">{{ row.reviewCount }} 条</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">管护责任移交清册</span>
          <el-button type="primary" @click="openCreate" :disabled="treeStore.trees.length === 0">
            <el-icon><Plus /></el-icon>
            <span>新建移交清册</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="transferStore.filters.keyword"
        :fields="[
          { key: 'status', label: '状态', options: TRANSFER_STATUS_OPTIONS as unknown as string[] },
          { key: 'reconcile', label: '对账', options: ['一致', '仅原单位有', '仅新单位有', '挂起待核'] },
        ]"
        :values="{ status: transferStore.filters.status, reconcile: transferStore.filters.reconcile }"
        :result-text="`命中 ${rows.length} / ${transferStore.rows.length} 册`"
        @update:keyword="(value: string) => transferStore.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="transferStore.resetFilters()"
      />

      <EmptyPanel
        v-if="transferStore.rows.length === 0 && !transferStore.loading"
        title="还没有管护责任移交记录"
        description="原单位把管护责任移交给新接手的养护单位时建立清册：交接日前的复评结论算原单位，交接后的检查、复壮与加固归新单位。"
        action-text="新建第一册移交清册"
        @action="openCreate"
      />

      <el-table v-else v-loading="transferStore.loading" :data="rows" row-key="id" stripe>
        <el-table-column label="清册编号 / 古树" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="detailId = row.id">{{ row.code }}</el-link>
              <span class="cell-sub">{{ row.treeCode }} · {{ treeLabel[row.treeId]?.split(' ')[1] ?? '' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="原单位 → 新单位" min-width="240">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.fromOwner }}</span>
              <span class="cell-sub">交接 {{ row.handoverDate }} → <b>{{ row.toOwner }}</b></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="逐株对账" width="120">
          <template #default="{ row }">
            <el-tag :type="reconcileTagType(row.reconcile)" size="small" effect="plain">{{ row.reconcile }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="两侧清册留存" min-width="200">
          <template #default="{ row }">
            <el-space wrap :size="6">
              <el-tag :type="row.fromArchived ? 'success' : 'info'" size="small">
                原单位档案室{{ row.fromArchived ? '已留存' : '缺失' }}
              </el-tag>
              <el-tag :type="row.toArchived ? 'success' : 'info'" size="small">
                新单位{{ row.toArchived ? '已留存' : '缺失' }}
              </el-tag>
            </el-space>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="detailId = row.id">明细</el-button>
            <el-button
              v-if="row.status === '待确认'"
              link
              type="success"
              size="small"
              @click="handleConfirm(row)"
            >确认移交</el-button>
            <el-button v-if="row.status === '待确认'" link type="warning" size="small" @click="handleSuspend(row)">
              挂起
            </el-button>
            <el-button v-if="row.status === '已挂起'" link type="primary" size="small" @click="handleResume(row)">
              恢复
            </el-button>
            <el-dropdown
              v-if="!row.fromArchived || !row.toArchived"
              trigger="click"
              @command="(side: 'from' | 'to') => handleRetry(row, side)"
            >
              <el-button link type="warning" size="small">
                重试缺失侧<el-icon class="el-icon--right"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-if="!row.fromArchived" command="from">
                    只重试{{ TRANSFER_SIDE_LABEL.from }}
                  </el-dropdown-item>
                  <el-dropdown-item v-if="!row.toArchived" command="to">
                    只重试{{ TRANSFER_SIDE_LABEL.to }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" title="新建管护责任移交清册" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="130px">
        <el-form-item label="移交古树" prop="treeId">
          <el-select v-model="form.treeId" filterable style="width: 100%">
            <el-option
              v-for="tree in treeStore.trees"
              :key="tree.id"
              :value="tree.id"
              :label="`${tree.code} · ${tree.species} · 现管护：${tree.owner}`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="原管护单位">
          <el-input :model-value="treeStore.trees.find((t) => t.id === form.treeId)?.owner ?? ''" disabled />
        </el-form-item>
        <el-form-item label="新接手养护单位" prop="toOwner">
          <el-input v-model="form.toOwner" placeholder="如：京诚古树养护有限公司" />
        </el-form-item>
        <el-form-item label="交接日期" prop="handoverDate">
          <el-date-picker v-model="form.handoverDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="清册留存">
          <el-space wrap>
            <el-checkbox v-model="form.fromArchived">原单位档案室留存</el-checkbox>
            <el-checkbox v-model="form.toArchived">新单位留存自己那份</el-checkbox>
          </el-space>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="可选：交接事项、现场清点说明" />
        </el-form-item>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="交接日前定稿的复评结论仍算原单位；交接日后的树体检查、复壮措施、加固件归新单位。两侧清册对账一致后才能确认。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存清册</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detailOpen" :title="detailRow ? `移交明细 · ${detailRow.code}` : '移交明细'" size="520px">
      <template v-if="detailRow && detailTree && detailScope">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="古树编号">{{ detailRow.treeCode }}</el-descriptions-item>
          <el-descriptions-item label="原管护单位">{{ detailRow.fromOwner }}</el-descriptions-item>
          <el-descriptions-item label="新接手单位">{{ detailRow.toOwner }}</el-descriptions-item>
          <el-descriptions-item label="交接日期">{{ detailRow.handoverDate }}</el-descriptions-item>
          <el-descriptions-item label="当前管护单位">{{ detailTree.owner }}</el-descriptions-item>
          <el-descriptions-item label="对账状态">{{ detailRow.reconcile }}</el-descriptions-item>
          <el-descriptions-item label="最近重试侧">
            {{ detailRow.lastRetrySide === '' ? '—' : TRANSFER_SIDE_LABEL[detailRow.lastRetrySide] }}
          </el-descriptions-item>
        </el-descriptions>

        <h4 class="scope-title">交接日前后归属拆分</h4>
        <el-row :gutter="10">
          <el-col :span="12">
            <el-card shadow="never" class="scope-card">
              <p class="scope-head">原单位段（{{ detailRow.handoverDate }} 前）</p>
              <p>树体检查 {{ detailScope.before.surveys.length }} 次</p>
              <p>复壮措施 {{ detailScope.before.measures.length }} 项</p>
              <p>加固件 {{ detailScope.before.supports.length }} 件</p>
              <p>复评结论 {{ detailScope.before.reviews.length }} 条（算原单位）</p>
            </el-card>
          </el-col>
          <el-col :span="12">
            <el-card shadow="never" class="scope-card is-new">
              <p class="scope-head">新单位段（{{ detailRow.handoverDate }} 及以后）</p>
              <p>树体检查 {{ detailScope.after.surveys.length }} 次</p>
              <p>复壮措施 {{ detailScope.after.measures.length }} 项</p>
              <p>加固件 {{ detailScope.after.supports.length }} 件</p>
              <p>复评结论 {{ detailScope.after.reviews.length }} 条（算新单位）</p>
            </el-card>
          </el-col>
        </el-row>

        <h4 class="scope-title">归属履历</h4>
        <el-timeline>
          <el-timeline-item
            v-for="(seg, idx) in detailTree.ownershipHistory"
            :key="idx"
            :timestamp="seg.startDate === '' ? '历史补录' : seg.startDate"
            placement="top"
          >
            <div class="timeline-title">{{ seg.owner }}</div>
            <div class="timeline-detail">{{ seg.note }}</div>
          </el-timeline-item>
        </el-timeline>
      </template>
    </el-drawer>
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

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.scope-title {
  margin: 18px 0 10px;
  font-size: 14px;
  color: #2f2a24;
}

.scope-card p {
  margin: 4px 0;
  font-size: 13px;
}

.scope-card.is-new {
  border-left: 4px solid #1e8449;
}

.scope-head {
  font-weight: 600;
}

.timeline-title {
  font-size: 13px;
  font-weight: 600;
}

.timeline-detail {
  font-size: 12px;
  color: #8c8479;
}
</style>
