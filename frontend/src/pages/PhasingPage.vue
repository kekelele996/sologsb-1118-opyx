<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Period, Stratum } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { usePhasing } from '@/hooks/usePhasing'
import { periodStore } from '@/stores/periodStore'
import { stratumStore } from '@/stores/stratumStore'
import { trenchStore } from '@/stores/trenchStore'
import { relationStore } from '@/stores/relationStore'
import { formatViolation, periodBoundsOf, validatePhasing, type PeriodViolation } from '@/utils/phasing'
import { uid } from '@/utils/id'

const periodState = useStore(periodStore)
const stratumState = useStore(stratumStore)
const trenchState = useStore(trenchStore)
const relationState = useStore(relationStore)

const filterTrenchId = ref('')
/** 编辑中的指派草稿（确认前不写库） */
const draft = reactive<Record<string, string>>({})
const dirty = ref(false)

const { violations, conflictUnitIds, periodNameOf, unitFullLabel, violationTexts } = usePhasing(
  computed(() => stratumState.strata),
  computed(() => relationState.relations),
  computed(() => periodState.periods),
  computed(() => periodState.assignments),
  computed(() => trenchState.trenches)
)

/** 草稿视图下的核验（含未保存修改） */
const draftViolations = computed<PeriodViolation[]>(() =>
  validatePhasing(stratumState.strata, relationState.relations, periodState.periods, draft).violations
)

const draftViolationTexts = computed(() =>
  draftViolations.value.map((item) => formatViolation(item, periodState.periods, relationState.relations, unitFullLabel))
)

const periodsSorted = computed(() => [...periodState.periods].sort((a, b) => a.order - b.order))

const visibleStrata = computed(() =>
  stratumState.strata.filter((item) => !filterTrenchId.value || item.trenchId === filterTrenchId.value)
)

/** 每个探方分组（按探方查看期别） */
const groups = computed(() =>
  trenchState.trenches
    .filter((trench) => !filterTrenchId.value || trench.id === filterTrenchId.value)
    .map((trench) => ({ trench, strata: visibleStrata.value.filter((item) => item.trenchId === trench.id) }))
    .filter((group) => group.strata.length > 0)
)

/** 以已保存指派为准重建草稿 */
function syncDraft(): void {
  Object.keys(draft).forEach((key) => delete draft[key])
  Object.entries(periodState.assignments).forEach(([stratumId, periodId]) => {
    draft[stratumId] = periodId
  })
  dirty.value = false
}

watch(
  () => periodState.assignments,
  () => {
    if (!dirty.value) syncDraft()
  },
  { deep: true, immediate: true }
)

function assignmentOf(stratumId: string): string {
  return draft[stratumId] ?? ''
}

function onAssign(stratumId: string, periodId: string): void {
  if (periodId) draft[stratumId] = periodId
  else delete draft[stratumId]
  dirty.value = true
}

/** 某单位草稿期别的关系链越界提示（基于当前草稿实时计算） */
function boundsWarning(stratum: Stratum): string | null {
  const periodId = draft[stratum.id]
  if (!periodId) return null
  const period = periodState.periods.find((item) => item.id === periodId)
  if (!period) return null
  const { minOrder, maxOrder } = periodBoundsOf(
    stratum.id,
    stratumState.strata,
    relationState.relations,
    periodState.periods,
    draft
  )
  if (minOrder !== null && period.order < minOrder) {
    const bound = periodsSorted.value.find((item) => item.order === minOrder)
    return `与关系链相抵：该单位为关系前项，期别不应早于后项（${bound?.name ?? `第 ${minOrder + 1} 期`}）`
  }
  if (maxOrder !== null && period.order > maxOrder) {
    const bound = periodsSorted.value.find((item) => item.order === maxOrder)
    return `与关系链相抵：该单位为关系后项，期别不应晚于前项（${bound?.name ?? `第 ${maxOrder + 1} 期`}）`
  }
  return null
}

/** 确认前沿关系链核验：绕回或与已有分期相抵则列出路径并挡住确认 */
async function confirmAssignments(): Promise<void> {
  const fails = draftViolations.value
  if (fails.length > 0) {
    const cycleCount = fails.filter((item) => item.kind === 'cycle').length
    const conflictCount = fails.length - cycleCount
    const lines = draftViolationTexts.value.map((text) => `- ${text}`).join('\n')
    await ElMessageBox.alert(
      `联合分期核验未通过（${cycleCount} 条绕回、${conflictCount} 条期别相抵），已挡住确认：\n\n${lines}`,
      '分期核验未通过',
      { type: 'error', customClass: 'phasing-error-box' }
    )
    return
  }
  await periodStore.getState().bulkAssign({ ...draft })
  syncDraft()
  ElMessage.success('联合分期已确认保存')
}

function discardDraft(): void {
  syncDraft()
  ElMessage.info('已放弃未确认的调整')
}

/** 批量把当前筛选视图内单位设为同一期别（仅改草稿） */
function assignVisible(periodId: string): void {
  visibleStrata.value.forEach((item) => {
    if (periodId) draft[item.id] = periodId
    else delete draft[item.id]
  })
  dirty.value = true
}

/* ---------------- 期别维护 ---------------- */

const periodDialogVisible = ref(false)
const editingPeriodId = ref<string | null>(null)
const periodForm = reactive({ name: '', note: '' })

function openCreatePeriod(): void {
  editingPeriodId.value = null
  periodForm.name = ''
  periodForm.note = ''
  periodDialogVisible.value = true
}

function openEditPeriod(period: Period): void {
  editingPeriodId.value = period.id
  periodForm.name = period.name
  periodForm.note = period.note
  periodDialogVisible.value = true
}

async function submitPeriod(): Promise<void> {
  const name = periodForm.name.trim()
  if (!name) {
    ElMessage.warning('请填写期别名称')
    return
  }
  if (periodState.periods.some((item) => item.id !== editingPeriodId.value && item.name === name)) {
    ElMessage.error(`期别「${name}」已存在，请更换名称`)
    return
  }
  if (editingPeriodId.value) {
    const target = periodState.periods.find((item) => item.id === editingPeriodId.value)
    if (!target) return
    await periodStore.getState().savePeriod({ ...target, name, note: periodForm.note.trim() })
    ElMessage.success(`期别 ${name} 已更新`)
  } else {
    const order = periodState.periods.length
    const row: Period = { id: uid('pd'), name, order, note: periodForm.note.trim() }
    await periodStore.getState().savePeriod(row)
    ElMessage.success(`期别 ${name} 已新增（默认排在最晚，可用「更早/更晚」调整）`)
  }
  periodDialogVisible.value = false
}

async function removePeriod(period: Period): Promise<void> {
  const used = stratumState.strata.filter((item) => periodState.assignments[item.id] === period.id).length
  await ElMessageBox.confirm(
    `确认删除期别「${period.name}」？${used > 0 ? `该期别下 ${used} 个单位将一并改为未定。` : ''}`,
    '删除确认',
    { type: 'warning' }
  )
  await periodStore.getState().removePeriod(period.id)
  syncDraft()
  ElMessage.success('期别已删除')
}

function periodCount(periodId: string): number {
  return stratumState.strata.filter((item) => periodState.assignments[item.id] === periodId).length
}

function unphasedCount(): number {
  return stratumState.strata.filter((item) => !periodState.assignments[item.id]).length
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">跨探方联合分期</h2>
        <p class="page-sub">
          记录员给单位统一定一期；跨方叠压/打破关系要求前项（堆积更晚）期别不早于后项（堆积更早）。确认前沿全部关系链核验，绕回或期别相抵将列出具体单位与路径并挡住确认。
        </p>
      </div>
      <el-button type="primary" @click="openCreatePeriod">
        <el-icon><Plus /></el-icon>新增期别
      </el-button>
    </div>

    <el-alert
      v-if="violations.length > 0"
      class="alert"
      type="error"
      :closable="false"
      show-icon
      :title="`已保存的分期存在 ${violations.length} 处矛盾（${violations.filter((v) => v.kind === 'cycle').length} 条绕回 / ${violations.filter((v) => v.kind === 'conflict').length} 条相抵）`"
    >
      <template #default>
        <p v-for="(text, index) in violationTexts" :key="index" class="violation-line">{{ text }}</p>
      </template>
    </el-alert>
    <el-alert
      v-else
      class="alert"
      type="success"
      :closable="false"
      show-icon
      title="已保存分期与全部层位关系链一致，无绕回、无期别相抵"
    />

    <div class="layout">
      <!-- 左：期别序列 -->
      <el-card shadow="never" class="period-card">
        <template #header>
          <div class="card-head">
            <span>期别序列（由早到晚）</span>
            <el-tag size="small" type="info" effect="plain">{{ periodsSorted.length }} 期</el-tag>
          </div>
        </template>
        <ul class="period-list">
          <li v-for="(period, index) in periodsSorted" :key="period.id" class="period-item">
            <div class="period-main">
              <el-tag :type="index === 0 ? 'success' : index === periodsSorted.length - 1 ? 'warning' : 'info'" effect="dark" size="small">
                {{ period.name }}
              </el-tag>
              <span class="muted">{{ period.note || '无说明' }}</span>
            </div>
            <div class="period-meta">
              <el-tag size="small" effect="plain">{{ periodCount(period.id) }} 个单位</el-tag>
              <el-button link size="small" :disabled="index === 0" @click="periodStore.getState().moveEarlier(period.id)">更早</el-button>
              <el-button link size="small" :disabled="index === periodsSorted.length - 1" @click="periodStore.getState().moveLater(period.id)">更晚</el-button>
              <el-button link type="primary" size="small" @click="openEditPeriod(period)">编辑</el-button>
              <el-button link type="danger" size="small" @click="removePeriod(period)">删除</el-button>
            </div>
          </li>
          <li v-if="periodsSorted.length === 0" class="muted empty">尚未建立任何期别，请先新增</li>
        </ul>
        <el-divider style="margin: 10px 0" />
        <p class="muted small">未定单位：<b>{{ unphasedCount() }}</b> 个；未定单位不参与期别相抵判断。</p>
      </el-card>

      <!-- 右：按探方指派 -->
      <el-card shadow="never" class="assign-card">
        <template #header>
          <div class="card-head">
            <span>单位定一期（按探方查看）</span>
            <div class="head-tools">
              <el-select v-model="filterTrenchId" placeholder="全部探方" clearable size="small" style="width: 170px">
                <el-option v-for="trench in trenchState.trenches" :key="trench.id" :label="`${trench.area} · ${trench.code}`" :value="trench.id" />
              </el-select>
              <el-dropdown trigger="click" @command="assignVisible">
                <el-button size="small" plain>批量定一期<el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-for="period in periodsSorted" :key="period.id" :command="period.id">
                      全部设为 {{ period.name }}
                    </el-dropdown-item>
                    <el-dropdown-item command="">全部置为未定</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>
        </template>

        <div v-for="group in groups" :key="group.trench.id" class="trench-group">
          <div class="group-title">
            <span class="trench-inline">{{ group.trench.area }} · {{ group.trench.code }}</span>
            <span class="muted small">{{ group.strata.length }} 个单位</span>
          </div>
          <el-table :data="group.strata" size="small" border class="assign-table">
            <el-table-column label="单位号" width="100">
              <template #default="{ row }: { row: Stratum }">
                <span class="mono" :class="{ 'in-conflict': conflictUnitIds.has(row.id) }">{{ row.code }}</span>
              </template>
            </el-table-column>
            <el-table-column label="类型" width="80" prop="type" />
            <el-table-column label="已确认期别" width="100">
              <template #default="{ row }: { row: Stratum }">
                <el-tag v-if="periodNameOf(row.id)" size="small" type="info" effect="plain">{{ periodNameOf(row.id) }}</el-tag>
                <span v-else class="muted">未定</span>
              </template>
            </el-table-column>
            <el-table-column label="调整为（草稿）" min-width="170">
              <template #default="{ row }: { row: Stratum }">
                <el-select
                  :model-value="assignmentOf(row.id)"
                  size="small"
                  clearable
                  placeholder="未定"
                  style="width: 130px"
                  @update:model-value="(value: string) => onAssign(row.id, value ?? '')"
                >
                  <el-option v-for="period in periodsSorted" :key="period.id" :label="period.name" :value="period.id" />
                </el-select>
                <el-tooltip v-if="boundsWarning(row)" :content="boundsWarning(row) ?? ''" placement="top">
                  <el-tag type="danger" size="small" effect="dark" class="mini">相抵</el-tag>
                </el-tooltip>
              </template>
            </el-table-column>
            <el-table-column label="关系链提示" min-width="220">
              <template #default="{ row }: { row: Stratum }">
                <span v-if="boundsWarning(row)" class="warn-text">{{ boundsWarning(row) }}</span>
                <span v-else-if="assignmentOf(row.id)" class="ok-text">满足关系链约束</span>
                <span v-else class="muted">待定</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <el-empty v-if="groups.length === 0" description="暂无地层单位，请先到「地层单位编目」录入" />

        <div class="draft-bar">
          <div class="draft-info">
            <el-tag :type="dirty ? 'warning' : 'success'" effect="plain" size="small">
              {{ dirty ? '存在未确认的调整' : '草稿与已保存分期一致' }}
            </el-tag>
            <el-tag v-if="draftViolations.length > 0" type="danger" effect="dark" size="small">
              草稿核验：{{ draftViolations.length }} 处矛盾
            </el-tag>
            <el-tag v-else type="success" effect="plain" size="small">草稿核验通过</el-tag>
          </div>
          <div class="draft-ops">
            <el-button size="small" :disabled="!dirty" @click="discardDraft">放弃调整</el-button>
            <el-button type="primary" size="small" :disabled="!dirty" @click="confirmAssignments">核验并确认分期</el-button>
          </div>
        </div>
      </el-card>
    </div>

    <el-dialog v-model="periodDialogVisible" :title="editingPeriodId ? '编辑期别' : '新增期别'" width="460px">
      <el-form label-width="84px">
        <el-form-item label="期别名称" required>
          <el-input v-model="periodForm.name" placeholder="如 一期、汉代层" />
        </el-form-item>
        <el-form-item label="分期说明">
          <el-input v-model="periodForm.note" type="textarea" :rows="2" placeholder="如 汉代文化层（最早）" />
        </el-form-item>
        <p class="muted small">新增期别默认排在序列最末（最晚），保存后用「更早/更晚」调整相对先后。</p>
      </el-form>
      <template #footer>
        <el-button @click="periodDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPeriod">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.alert {
  margin-bottom: 14px;
}
.violation-line {
  margin: 2px 0;
  line-height: 1.6;
}
.layout {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}
.period-card {
  flex: 1 1 300px;
  border-radius: 12px;
}
.assign-card {
  flex: 2 1 560px;
  border-radius: 12px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.head-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}
.period-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.period-item {
  padding: 8px 0;
  border-bottom: 1px dotted #e6ded0;
}
.period-main {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.period-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-left: 4px;
}
.small {
  font-size: 12px;
}
.empty {
  padding: 12px 0;
}
.trench-group {
  margin-bottom: 14px;
}
.group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-weight: 600;
  font-size: 13px;
}
.trench-inline {
  color: #8a5a2b;
}
.mini {
  margin-left: 6px;
}
.warn-text {
  color: #c0392b;
  font-size: 12px;
}
.ok-text {
  color: #1f8a70;
  font-size: 12px;
}
.in-conflict {
  color: #c0392b;
  font-weight: 700;
}
.draft-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  margin-top: 8px;
  background: #fbfaf6;
  border: 1px solid #e6ded0;
  border-radius: 10px;
}
.draft-info,
.draft-ops {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>

<style>
.phasing-error-box .el-message-box__message {
  white-space: pre-wrap;
  line-height: 1.7;
  font-size: 12px;
}
</style>
