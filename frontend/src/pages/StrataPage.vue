<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Inclusion, Stratum, UnitType } from '@/types'
import { INCLUSIONS, UNIT_TYPES, isCodeDuplicated, isDepthInverted, stratumThickness } from '@/types'
import StratumDepthBar from '@/components/common/StratumDepthBar.vue'
import TrenchTag from '@/components/common/TrenchTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useStratumOrder } from '@/hooks/useStratumOrder'
import { usePhasing } from '@/hooks/usePhasing'
import { stratumStore } from '@/stores/stratumStore'
import { trenchStore } from '@/stores/trenchStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { periodStore } from '@/stores/periodStore'
import { uid } from '@/utils/id'

const trenchState = useStore(trenchStore)
const stratumState = useStore(stratumStore)
const artifactState = useStore(artifactStore)
const relationState = useStore(relationStore)
const periodState = useStore(periodStore)

const { result: order } = useStratumOrder(
  computed(() => stratumState.strata),
  computed(() => relationState.relations)
)

const { conflictUnitIds, periodNameOf, violationTexts } = usePhasing(
  computed(() => stratumState.strata),
  computed(() => relationState.relations),
  computed(() => periodState.periods),
  computed(() => periodState.assignments),
  computed(() => trenchState.trenches)
)

const filterTrenchId = ref('')
const filterType = ref<UnitType | ''>('')
const filterPeriodId = ref<string>('')
const depthFrom = ref<number | undefined>(undefined)
const depthTo = ref<number | undefined>(undefined)
const selectedIds = ref<string[]>([])
const batchType = ref<UnitType>('地层')

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)

const form = reactive({
  trenchId: '',
  code: '',
  type: '地层' as UnitType,
  openLayer: '第①层',
  topDepth: 0,
  bottomDepth: 0.3,
  soil: '',
  inclusions: [] as Inclusion[],
  formation: '',
  date: new Date().toISOString().slice(0, 10),
  drawingNo: ''
})

const periodsSorted = computed(() => [...periodState.periods].sort((a, b) => a.order - b.order))

const visible = computed(() =>
  stratumState.strata.filter((item) => {
    if (filterTrenchId.value && item.trenchId !== filterTrenchId.value) return false
    if (filterType.value && item.type !== filterType.value) return false
    if (filterPeriodId.value === '__none__' && periodState.assignments[item.id]) return false
    if (filterPeriodId.value && filterPeriodId.value !== '__none__' && periodState.assignments[item.id] !== filterPeriodId.value)
      return false
    if (depthFrom.value !== undefined && item.bottomDepth < depthFrom.value) return false
    if (depthTo.value !== undefined && item.topDepth > depthTo.value) return false
    return true
  })
)

/** 按探方查看期别：分组统计 */
const trenchPeriodGroups = computed(() =>
  trenchState.trenches
    .filter((trench) => !filterTrenchId.value || trench.id === filterTrenchId.value)
    .map((trench) => {
      const units = stratumState.strata.filter((item) => item.trenchId === trench.id)
      const byPeriod = new Map<string, number>()
      units.forEach((unit) => {
        const periodId = periodState.assignments[unit.id] ?? '__none__'
        byPeriod.set(periodId, (byPeriod.get(periodId) ?? 0) + 1)
      })
      return { trench, units: units.length, byPeriod }
    })
)

function trenchLabel(trenchId: string): string {
  const trench = trenchState.trenches.find((item) => item.id === trenchId)
  return trench ? `${trench.area} · ${trench.code}` : '未知探方'
}

function artifactsOf(stratumId: string): number {
  return artifactState.artifacts.filter((item) => item.stratumId === stratumId).reduce((sum, item) => sum + item.count, 0)
}

function invertedOf(stratum: Stratum): boolean {
  return isDepthInverted(stratum)
}

function duplicatedOf(stratum: Stratum): boolean {
  return isCodeDuplicated(stratumState.strata, stratum)
}

function rowClass(param: { row: Stratum }): string {
  if (invertedOf(param.row)) return 'inverted-row'
  if (duplicatedOf(param.row)) return 'duplicate-row'
  if (conflictUnitIds.value.has(param.row.id)) return 'phasing-conflict-row'
  return ''
}

/** 与层位关系矛盾的告警（按单位过滤） */
const conflictOf = (code: string): string | null =>
  order.value.conflicts.find((item) => item.startsWith(code)) ?? null

watch(
  () => [trenchState.trenches.length, form.trenchId] as const,
  () => {
    if (!form.trenchId && trenchState.trenches.length > 0) form.trenchId = trenchState.trenches[0].id
  },
  { immediate: true }
)

function resetForm(): void {
  editingId.value = null
  form.trenchId = trenchState.trenches[0]?.id ?? ''
  form.code = ''
  form.type = '地层'
  form.openLayer = '第①层'
  form.topDepth = 0
  form.bottomDepth = 0.3
  form.soil = ''
  form.inclusions = []
  form.formation = ''
  form.date = new Date().toISOString().slice(0, 10)
  form.drawingNo = ''
}

function openCreate(): void {
  resetForm()
  dialogVisible.value = true
}

function openEdit(stratum: Stratum): void {
  editingId.value = stratum.id
  Object.assign(form, {
    trenchId: stratum.trenchId,
    code: stratum.code,
    type: stratum.type,
    openLayer: stratum.openLayer,
    topDepth: stratum.topDepth,
    bottomDepth: stratum.bottomDepth,
    soil: stratum.soil,
    inclusions: [...stratum.inclusions],
    formation: stratum.formation,
    date: stratum.date,
    drawingNo: stratum.drawingNo
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  if (!form.trenchId) {
    ElMessage.warning('请选择所属探方')
    return
  }
  if (!form.code.trim()) {
    ElMessage.warning('请填写单位号（如 H12、L03）')
    return
  }
  if (form.topDepth < 0 || form.bottomDepth < 0) {
    ElMessage.warning('深度不能为负值')
    return
  }
  const candidate = { id: editingId.value ?? uid('st'), trenchId: form.trenchId, code: form.code.trim().toUpperCase() }
  if (isCodeDuplicated(stratumState.strata, candidate)) {
    ElMessage.error(`同一探方内单位号「${candidate.code}」已存在，请更换`)
    return
  }
  const row: Stratum = {
    id: candidate.id,
    trenchId: candidate.trenchId,
    code: candidate.code,
    type: form.type,
    openLayer: form.openLayer.trim(),
    topDepth: Number(form.topDepth) || 0,
    bottomDepth: Number(form.bottomDepth) || 0,
    soil: form.soil.trim(),
    inclusions: [...form.inclusions],
    formation: form.formation.trim(),
    date: form.date,
    drawingNo: form.drawingNo.trim()
  }
  await stratumStore.getState().save(row)
  if (isDepthInverted(row)) {
    ElMessage.warning(`已保存，但「${row.code}」上界深度大于下界，层序倒置需复核`)
  } else {
    ElMessage.success(`地层单位 ${row.code} 已保存（厚 ${stratumThickness(row)} m）`)
  }
  dialogVisible.value = false
}

async function remove(stratum: Stratum): Promise<void> {
  const count = artifactState.artifacts.filter((item) => item.stratumId === stratum.id).length
  const relations = relationState.relations.filter(
    (item) => item.unitAId === stratum.id || item.unitBId === stratum.id
  ).length
  if (count > 0 || relations > 0) {
    ElMessage.error(`「${stratum.code}」下仍有 ${count} 件出土物、${relations} 条层位关系，请先清理`)
    return
  }
  await ElMessageBox.confirm(`确认删除地层单位「${stratum.code}」？`, '删除确认', { type: 'warning' })
  await stratumStore.getState().remove(stratum.id)
  await periodStore.getState().removeAssignmentsByStratum(stratum.id)
  ElMessage.success('地层单位已删除')
}

async function applyBatchType(): Promise<void> {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要调整的单位')
    return
  }
  await stratumStore.getState().bulkSetType(selectedIds.value, batchType.value)
  ElMessage.success(`已把 ${selectedIds.value.length} 个单位的类型调整为「${batchType.value}」`)
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">地层单位编目表</h2>
        <p class="page-sub">
          按类型与深度区间筛选；层序倒置（上界大于下界）与同一探方内单位号重复即时高亮提示，深度刻度条展示厚度。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>新建地层单位
      </el-button>
    </div>

    <el-alert
      v-if="order.inverted.length > 0 || order.duplicateCodes.length > 0 || conflictUnitIds.size > 0"
      class="alert"
      type="warning"
      :closable="false"
      show-icon
      :title="`发现 ${order.inverted.length} 个层序倒置单位、${order.duplicateCodes.length} 个重复单位号、${conflictUnitIds.size} 个单位卷入跨方分期矛盾`"
    >
      <template #default>
        <p v-if="order.inverted.length > 0">
          层序倒置：{{ order.inverted.map((item) => item.code).join('、') }}（上界深度大于下界深度）
        </p>
        <p v-if="order.duplicateCodes.length > 0">单位号重复：{{ order.duplicateCodes.join('、') }}</p>
        <p v-if="order.conflicts.length > 0">
          与层位关系矛盾：{{ order.conflicts.join('；') }}
        </p>
        <p v-for="(text, index) in violationTexts" :key="`pv${index}`" class="conflict-text">{{ text }}</p>
      </template>
    </el-alert>
    <el-alert
      v-else
      class="alert"
      type="success"
      :closable="false"
      show-icon
      title="层序、单位号与跨方分期校验通过"
    />

    <el-card shadow="never" class="period-overview">
      <template #header>
        <div class="overview-head">
          <span>按探方查看期别</span>
          <el-button link type="primary" size="small" @click="$router.push('/phasing')">前往联合分期调整 →</el-button>
        </div>
      </template>
      <div class="overview-grid">
        <div v-for="group in trenchPeriodGroups" :key="group.trench.id" class="overview-cell">
          <div class="cell-head">{{ group.trench.area }} · {{ group.trench.code }}</div>
          <div class="cell-tags">
            <el-tag
              v-for="period in periodsSorted.filter((p) => group.byPeriod.has(p.id))"
              :key="period.id"
              size="small"
              effect="dark"
              class="mini"
            >
              {{ period.name }} × {{ group.byPeriod.get(period.id) }}
            </el-tag>
            <el-tag v-if="group.byPeriod.get('__none__')" size="small" type="info" effect="plain" class="mini">
              未定 × {{ group.byPeriod.get('__none__') }}
            </el-tag>
            <span v-if="group.units === 0" class="muted">暂无单位</span>
          </div>
        </div>
        <p v-if="trenchPeriodGroups.length === 0" class="muted">暂无探方</p>
      </div>
    </el-card>

    <div class="toolbar">
      <el-select v-model="filterTrenchId" placeholder="全部探方" clearable style="width: 190px">
        <el-option v-for="trench in trenchState.trenches" :key="trench.id" :label="`${trench.area} · ${trench.code}`" :value="trench.id" />
      </el-select>
      <el-select v-model="filterType" placeholder="全部类型" clearable style="width: 130px">
        <el-option v-for="type in UNIT_TYPES" :key="type" :label="type" :value="type" />
      </el-select>
      <el-select v-model="filterPeriodId" placeholder="全部期别" clearable style="width: 140px">
        <el-option v-for="period in periodsSorted" :key="period.id" :label="period.name" :value="period.id" />
        <el-option label="未定" value="__none__" />
      </el-select>
      <div class="depth">
        <span class="muted">深度区间（米）</span>
        <el-input-number v-model="depthFrom" :min="0" :step="0.1" :controls="false" placeholder="起" style="width: 100px" />
        <span>—</span>
        <el-input-number v-model="depthTo" :min="0" :step="0.1" :controls="false" placeholder="止" style="width: 100px" />
      </div>
      <el-select v-model="batchType" style="width: 130px">
        <el-option v-for="type in UNIT_TYPES" :key="type" :label="type" :value="type" />
      </el-select>
      <el-button type="primary" plain @click="applyBatchType">批量调整类型</el-button>
      <el-tag type="info" effect="plain">命中 {{ visible.length }} / {{ stratumState.strata.length }} 个单位</el-tag>
    </div>

    <el-table
      :data="visible"
      border
      stripe
      row-key="id"
      :row-class-name="rowClass"
      @selection-change="(rows: Stratum[]) => (selectedIds = rows.map((row) => row.id))"
    >
      <el-table-column type="selection" width="46" />
      <el-table-column label="序号" width="70">
        <template #default="{ row }: { row: Stratum }">{{ order.indexOf.get(row.id) ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="探方" width="150">
        <template #default="{ row }: { row: Stratum }">
          <span class="mono">{{ trenchLabel(row.trenchId) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="单位号" width="110">
        <template #default="{ row }: { row: Stratum }">
          <span class="mono">{{ row.code }}</span>
          <el-tag v-if="duplicatedOf(row)" type="warning" size="small" effect="dark" class="mini">重复</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="120">
        <template #default="{ row }: { row: Stratum }">
          <TrenchTag :unit-type="row.type" size="small" />
        </template>
      </el-table-column>
      <el-table-column label="深度刻度" width="250">
        <template #default="{ row }: { row: Stratum }">
          <StratumDepthBar :stratum="row" :length="180" />
        </template>
      </el-table-column>
      <el-table-column label="开口层位" width="110" prop="openLayer" />
      <el-table-column label="土质土色" min-width="150" prop="soil" show-overflow-tooltip />
      <el-table-column label="包含物" width="150">
        <template #default="{ row }: { row: Stratum }">
          <el-tag v-for="item in row.inclusions" :key="item" size="small" effect="plain" class="mini">{{ item }}</el-tag>
          <span v-if="row.inclusions.length === 0" class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="期别" width="90">
        <template #default="{ row }: { row: Stratum }">
          <el-tag v-if="periodNameOf(row.id)" size="small" effect="dark" type="warning">{{ periodNameOf(row.id) }}</el-tag>
          <span v-else class="muted">未定</span>
        </template>
      </el-table-column>
      <el-table-column label="出土物" width="90">
        <template #default="{ row }: { row: Stratum }">{{ artifactsOf(row.id) }} 件</template>
      </el-table-column>
      <el-table-column label="校验" width="124">
        <template #default="{ row }: { row: Stratum }">
          <el-tag v-if="invertedOf(row)" type="danger" size="small" effect="dark">层序倒置</el-tag>
          <el-tag v-else-if="conflictOf(row.code)" type="warning" size="small" effect="dark">关系矛盾</el-tag>
          <el-tag v-else-if="conflictUnitIds.has(row.id)" type="danger" size="small" effect="dark">分期相抵</el-tag>
          <el-tag v-else type="success" size="small" effect="plain">正常</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }: { row: Stratum }">
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑地层单位' : '新建地层单位'" width="680px">
      <el-form label-width="110px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="所属探方" required>
              <el-select v-model="form.trenchId" style="width: 100%">
                <el-option v-for="trench in trenchState.trenches" :key="trench.id" :label="`${trench.area} · ${trench.code}`" :value="trench.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="单位号" required>
              <el-input v-model="form.code" placeholder="如 H12、L03" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="单位类型">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="type in UNIT_TYPES" :key="type" :label="type" :value="type" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="开口层位">
              <el-input v-model="form.openLayer" placeholder="如 第②层下" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="上界深度(m)">
              <el-input-number v-model="form.topDepth" :min="0" :step="0.05" :precision="2" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="下界深度(m)">
              <el-input-number v-model="form.bottomDepth" :min="0" :step="0.05" :precision="2" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="厚度">
              <el-input :model-value="`${Math.abs(form.bottomDepth - form.topDepth).toFixed(2)} m`" disabled />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="土质土色">
          <el-input v-model="form.soil" placeholder="如 灰褐色砂质黏土，疏松" />
        </el-form-item>
        <el-form-item label="包含物">
          <el-checkbox-group v-model="form.inclusions">
            <el-checkbox v-for="item in INCLUSIONS" :key="item" :value="item">{{ item }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="堆积成因">
          <el-input v-model="form.formation" placeholder="如 生活垃圾坑" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="发掘日期">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="绘图/拍照号">
              <el-input v-model="form.drawingNo" placeholder="如 T0501-北壁-02" />
            </el-form-item>
          </el-col>
        </el-row>
        <p v-if="form.topDepth > form.bottomDepth" class="warn">上界深度大于下界深度，保存后将标记为「层序倒置」</p>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.alert {
  margin-bottom: 14px;
}
.conflict-text {
  color: #c0392b;
  line-height: 1.6;
}
.period-overview {
  margin-bottom: 14px;
  border-radius: 12px;
}
.overview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.overview-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.overview-cell {
  min-width: 220px;
  flex: 1 1 220px;
  padding: 8px 10px;
  border: 1px solid #ece4d5;
  border-radius: 8px;
  background: #fbfaf6;
}
.cell-head {
  font-size: 13px;
  font-weight: 600;
  color: #8a5a2b;
  margin-bottom: 6px;
}
.cell-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.depth {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mini {
  margin-left: 4px;
}
.warn {
  margin: 0;
  color: #c0392b;
  font-size: 12px;
}
:deep(.phasing-conflict-row) {
  background: #fdecea !important;
}
</style>
