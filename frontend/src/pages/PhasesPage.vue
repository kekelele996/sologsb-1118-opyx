<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Relation, Stratum } from '@/types'
import { phaseLabel, suggestPhases, validatePhases, type PhaseIssue } from '@/utils/phasing'
import { useStore } from '@/hooks/usePersistentStore'
import { stratumStore } from '@/stores/stratumStore'
import { trenchStore } from '@/stores/trenchStore'
import { relationStore } from '@/stores/relationStore'

const stratumState = useStore(stratumStore)
const trenchState = useStore(trenchStore)
const relationState = useStore(relationStore)

const filterTrenchId = ref('')
const filterPhase = ref<number | null>(null)

/** 草稿期别：未点「保存分期」前不落库 */
const drafts = reactive<Record<string, number | null>>({})

watch(
  () => stratumState.strata.map((item) => `${item.id}:${item.phase ?? ''}`).join('|'),
  () => {
    stratumState.strata.forEach((item) => {
      if (!(item.id in drafts)) drafts[item.id] = item.phase ?? null
    })
    Object.keys(drafts).forEach((id) => {
      if (!stratumState.strata.some((item) => item.id === id)) delete drafts[id]
    })
  },
  { immediate: true }
)

function trenchOf(stratumId: string) {
  const stratum = stratumState.strata.find((item) => item.id === stratumId)
  return trenchState.trenches.find((item) => item.id === stratum?.trenchId) ?? null
}

function unitName(stratumId: string): string {
  const stratum = stratumState.strata.find((item) => item.id === stratumId)
  if (!stratum) return `未知单位(${stratumId})`
  const trench = trenchOf(stratumId)
  return trench ? `${trench.code}·${stratum.code}` : stratum.code
}

function unitType(stratumId: string): string {
  return stratumState.strata.find((item) => item.id === stratumId)?.type ?? ''
}

/** 一条核验问题 → 带单位期别与跨方标注的纯文本路径 */
function issuePathText(issue: PhaseIssue): string {
  const parts: string[] = []
  issue.unitIds.forEach((id, index) => {
    const useEndpoint =
      (issue.kind === 'conflict' || issue.kind === 'coexistence') &&
      (index === 0 || index === issue.unitIds.length - 1)
    const phase = useEndpoint
      ? index === 0
        ? issue.startPhase
        : issue.endPhase
      : drafts[id] ?? stratumState.strata.find((item) => item.id === id)?.phase ?? null
    parts.push(`${unitName(id)}（${unitType(id)}·${phaseLabel(phase)}）`)
    if (index < issue.steps.length) {
      const step = issue.steps[index]
      const relation = relationState.relations.find((item) => item.id === step.relationId)
      const crossTrench =
        relation && trenchOf(relation.unitAId)?.id !== trenchOf(relation.unitBId)?.id
      parts.push(`${crossTrench ? '【跨方】' : ''}—${step.type}→`)
    }
  })
  return parts.join(' ')
}

/** 问题摘要标题 */
function issueTitle(issue: PhaseIssue): string {
  if (issue.kind === 'cycle') return '关系链绕回（环路），无法分期'
  if (issue.kind === 'coexistence') {
    const first = unitName(issue.unitIds[0])
    const last = unitName(issue.unitIds[issue.unitIds.length - 1])
    return `共存单位期别不一致：${first}（${phaseLabel(issue.startPhase ?? null)}）与 ${last}（${phaseLabel(issue.endPhase ?? null)}）应为同期`
  }
  const first = unitName(issue.unitIds[0])
  const last = unitName(issue.unitIds[issue.unitIds.length - 1])
  return `期别相抵：${first}（${phaseLabel(issue.startPhase ?? null)}）沿关系链晚于 ${last}（${phaseLabel(issue.endPhase ?? null)}），应满足前项期别不晚于后项`
}

/** 当前草稿的全量核验结果（实时） */
const liveIssues = computed<PhaseIssue[]>(() => {
  const phases = new Map<string, number | null>(stratumState.strata.map((item) => [item.id, drafts[item.id] ?? null]))
  return validatePhases(stratumState.strata, relationState.relations, phases)
})

/** 仅期别相抵（不含环路） */
const conflicts = computed(() => liveIssues.value.filter((item) => item.kind === 'conflict'))
const coexistIssues = computed(() => liveIssues.value.filter((item) => item.kind === 'coexistence'))
const cycles = computed(() => liveIssues.value.filter((item) => item.kind === 'cycle'))

const involvedIds = computed(() => new Set(liveIssues.value.flatMap((issue) => issue.unitIds)))

const visible = computed(() =>
  stratumState.strata.filter((item) => {
    if (filterTrenchId.value && item.trenchId !== filterTrenchId.value) return false
    if (filterPhase.value !== null && (drafts[item.id] ?? null) !== filterPhase.value) return false
    return true
  })
)

const phaseOptions = computed(() => {
  const set = new Set<number>()
  stratumState.strata.forEach((item) => {
    const value = drafts[item.id]
    if (typeof value === 'number') set.add(value)
  })
  return Array.from(set).sort((a, b) => a - b)
})

const assignedCount = computed(
  () => stratumState.strata.filter((item) => typeof drafts[item.id] === 'number').length
)

const dirty = computed(() =>
  stratumState.strata.some((item) => (drafts[item.id] ?? null) !== (item.phase ?? null))
)

function rowClass(param: { row: Stratum }): string {
  return involvedIds.value.has(param.row.id) ? 'conflict-row' : ''
}

/** 单位直接关系链（用于行内提示） */
function relationsOf(stratumId: string): Relation[] {
  return relationState.relations.filter((item) => item.unitAId === stratumId || item.unitBId === stratumId)
}

function relationText(relation: Relation, selfId: string): string {
  const otherId = relation.unitAId === selfId ? relation.unitBId : relation.unitAId
  const arrow = relation.type === '共存' ? '＝共存＝' : relation.unitAId === selfId ? `—${relation.type}→` : `←${relation.type}—`
  const other = stratumState.strata.find((item) => item.id === otherId)
  const cross = other && other.trenchId !== (stratumState.strata.find((item) => item.id === selfId)?.trenchId ?? '')
  return `${cross ? '【跨方】' : ''}${arrow} ${unitName(otherId)}`
}

function applySuggestions(): void {
  const suggestions = suggestPhases(stratumState.strata, relationState.relations)
  let filled = 0
  suggestions.forEach((phase, id) => {
    if ((drafts[id] ?? null) === null) {
      drafts[id] = phase
      filled += 1
    }
  })
  if (filled === 0) {
    ElMessage.info('没有可自动建议的未定级单位（孤立单位需记录员人工判断）')
  } else {
    ElMessage.success(`已按叠压/打破关系链为 ${filled} 个未定级单位建议期别，请核对后保存`)
  }
}

function buildIssuesHtml(): string {
  const escape = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return liveIssues.value
    .map((issue, index) => {
      const color = issue.kind === 'cycle' ? '#c0392b' : '#b8860b'
      return `<p style="margin:6px 0"><b style="color:${color}">${index + 1}. ${escape(issueTitle(issue))}</b><br/><span style="color:#5c4a35">${escape(issuePathText(issue))}</span></p>`
    })
    .join('')
}

async function save(): Promise<void> {
  if (liveIssues.value.length > 0) {
    await ElMessageBox.alert(buildIssuesHtml(), '联合分期核验未通过，已挡住保存', {
      type: 'error',
      dangerouslyUseHTMLString: true,
      customClass: 'phase-confirm'
    })
    return
  }
  const phases = new Map<string, number | null>()
  stratumState.strata.forEach((item) => phases.set(item.id, drafts[item.id] ?? null))
  await stratumStore.getState().bulkSetPhases(phases)
  ElMessage.success(`分期结果已保存：${assignedCount.value} 个单位已定级，重开后仍保留`)
}

function resetDrafts(): void {
  stratumState.strata.forEach((item) => {
    drafts[item.id] = item.phase ?? null
  })
  ElMessage.info('已放弃未保存的调整，恢复到上次保存的分期')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">跨探方联合分期</h2>
        <p class="page-sub">
          记录员为各探方单位统一按期定级；保存前沿叠压/打破（含共存）关系链核验：前项期别不得晚于后项。
          期别编号越大越早（与地层深浅一致）。绕回或期别相抵时列出具体单位与关系路径并挡住确认。
        </p>
      </div>
      <div class="head-actions">
        <el-button @click="applySuggestions">
          <el-icon><MagicStick /></el-icon>按关系链建议期别
        </el-button>
        <el-button :disabled="!dirty" @click="resetDrafts">撤销调整</el-button>
        <el-button type="primary" :disabled="!dirty" @click="save">
          <el-icon><Check /></el-icon>保存分期
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="liveIssues.length > 0"
      class="alert"
      type="error"
      :closable="false"
      show-icon
      :title="`核验未通过：${cycles.length} 条关系链绕回、${conflicts.length} 条期别相抵、${coexistIssues.length} 对共存不同期，保存将被挡住`"
    >
      <template #default>
        <div v-for="(issue, index) in liveIssues" :key="index" class="issue">
          <p class="issue-title">{{ index + 1 }}. {{ issueTitle(issue) }}</p>
          <p class="issue-path">
            <el-tag size="small" :type="issue.kind === 'cycle' ? 'danger' : issue.kind === 'conflict' ? 'warning' : 'primary'" effect="dark">
              {{ issue.kind === 'cycle' ? '绕回路径' : issue.kind === 'conflict' ? '相抵路径' : '共存路径' }}
            </el-tag>
            {{ issuePathText(issue) }}
          </p>
        </div>
      </template>
    </el-alert>
    <el-alert
      v-else
      class="alert"
      type="success"
      :closable="false"
      show-icon
      :title="`关系链核验通过：${assignedCount}/${stratumState.strata.length} 个单位已定级，叠压/打破前后项期别一致`"
    />

    <div class="toolbar">
      <el-select v-model="filterTrenchId" placeholder="全部探方" clearable style="width: 200px">
        <el-option v-for="trench in trenchState.trenches" :key="trench.id" :label="`${trench.area} · ${trench.code}`" :value="trench.id" />
      </el-select>
      <el-select v-model="filterPhase" placeholder="全部期别" clearable style="width: 150px">
        <el-option v-for="phase in phaseOptions" :key="phase" :label="phaseLabel(phase)" :value="phase" />
      </el-select>
      <el-tag type="info" effect="plain">命中 {{ visible.length }} / {{ stratumState.strata.length }} 个单位</el-tag>
      <el-tag v-for="phase in phaseOptions" :key="phase" type="warning" effect="plain">
        {{ phaseLabel(phase) }}：{{ stratumState.strata.filter((item) => drafts[item.id] === phase).length }} 个
      </el-tag>
      <el-tag v-if="stratumState.strata.some((item) => (drafts[item.id] ?? null) === null)" type="info" effect="plain">
        未分期：{{ stratumState.strata.filter((item) => (drafts[item.id] ?? null) === null).length }} 个
      </el-tag>
      <el-tag v-if="dirty" type="danger" effect="dark">有未保存的调整</el-tag>
    </div>

    <el-table :data="visible" border stripe row-key="id" :row-class-name="rowClass">
      <el-table-column label="探方" width="170">
        <template #default="{ row }: { row: Stratum }">
          <span class="mono">{{ trenchOf(row.id) ? `${trenchOf(row.id)?.area} · ${trenchOf(row.id)?.code}` : '未知探方' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="单位号" width="100">
        <template #default="{ row }: { row: Stratum }"><span class="mono">{{ row.code }}</span></template>
      </el-table-column>
      <el-table-column label="类型" width="90" prop="type" />
      <el-table-column label="深度(m)" width="120">
        <template #default="{ row }: { row: Stratum }">{{ row.topDepth }}–{{ row.bottomDepth }}</template>
      </el-table-column>
      <el-table-column label="期别（编号越大越早）" width="200">
        <template #default="{ row }: { row: Stratum }">
          <div class="phase-edit">
            <el-input-number
              v-model="drafts[row.id]"
              :min="1"
              :max="20"
              :step="1"
              :precision="0"
              :controls="false"
              size="small"
              placeholder="未定级"
              style="width: 96px"
            />
            <el-button v-if="drafts[row.id] !== null" link type="info" size="small" @click="drafts[row.id] = null">
              置未分期
            </el-button>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="关系链（直接）" min-width="260">
        <template #default="{ row }: { row: Stratum }">
          <template v-if="relationsOf(row.id).length > 0">
            <el-tag
              v-for="relation in relationsOf(row.id)"
              :key="relation.id"
              size="small"
              :type="relation.unitAId !== relation.unitBId && trenchOf(relation.unitAId)?.id !== trenchOf(relation.unitBId)?.id ? 'danger' : 'info'"
              effect="plain"
              class="mini"
            >
              {{ relationText(relation, row.id) }}
            </el-tag>
          </template>
          <span v-else class="muted">无直接关系（孤立单位）</span>
        </template>
      </el-table-column>
      <el-table-column label="核验状态" width="150">
        <template #default="{ row }: { row: Stratum }">
          <el-tag v-if="involvedIds.has(row.id)" type="danger" size="small" effect="dark">相抵/绕回</el-tag>
          <el-tag v-else-if="drafts[row.id] === null" type="info" size="small" effect="plain">未分期</el-tag>
          <el-tag v-else type="success" size="small" effect="plain">{{ phaseLabel(drafts[row.id]) }}</el-tag>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.alert {
  margin-bottom: 14px;
}
.head-actions {
  display: flex;
  gap: 8px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.mini {
  margin: 2px 4px 2px 0;
}
.phase-edit {
  display: flex;
  align-items: center;
  gap: 4px;
}
.issue {
  margin-top: 6px;
}
.issue-title {
  margin: 0 0 2px;
  font-weight: 600;
}
.issue-path {
  margin: 0;
  color: #5c4a35;
  font-size: 12px;
}
:deep(.conflict-row) {
  background-color: #fdecea !important;
}
</style>
