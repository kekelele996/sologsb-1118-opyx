import { computed, type Ref } from 'vue'
import type { Period, Relation, Stratum, Trench } from '@/types'
import {
  formatViolation,
  periodBoundsOf,
  validatePhasing,
  type PeriodAssignments,
  type PeriodViolation
} from '@/utils/phasing'

export interface PhasingResult {
  violations: Ref<PeriodViolation[]>
  /** 按单位 id 汇总的相抵关系（存在即矛盾），供编目表行内高亮 */
  conflictUnitIds: Ref<Set<string>>
  periodNameOf: (stratumId: string) => string
  periodOrderOf: (stratumId: string) => number | null
  /** 带探方号的单位全称，如「Ⅱ区·T0501 / H12」 */
  unitFullLabel: (stratumId: string) => string
  /** 核验结果逐条文本（含具体单位与关系路径） */
  violationTexts: Ref<string[]>
  boundsOf: (stratumId: string) => { minOrder: number | null; maxOrder: number | null }
}

/**
 * 跨探方联合分期核验与展示的统一入口：
 * 保存/调整分期前调用 validatePhasing 沿关系链核验；页面用本 hook 取期别名、矛盾高亮与路径文案。
 */
export function usePhasing(
  strata: Ref<Stratum[]>,
  relations: Ref<Relation[]>,
  periods: Ref<Period[]>,
  assignments: Ref<PeriodAssignments>,
  trenches: Ref<Trench[]>
): PhasingResult {
  const result = computed(() =>
    validatePhasing(strata.value, relations.value, periods.value, assignments.value)
  )
  const violations = computed(() => result.value.violations)

  const conflictUnitIds = computed(() => {
    const ids = new Set<string>()
    violations.value.forEach((item) => item.path.forEach((id) => ids.add(id)))
    return ids
  })

  const periodById = computed(() => {
    const map = new Map<string, Period>()
    periods.value.forEach((period) => map.set(period.id, period))
    return map
  })

  const periodNameOf = (stratumId: string): string => {
    const periodId = assignments.value[stratumId]
    if (!periodId) return ''
    return periodById.value.get(periodId)?.name ?? ''
  }

  const periodOrderOf = (stratumId: string): number | null => {
    const periodId = assignments.value[stratumId]
    if (!periodId) return null
    return periodById.value.get(periodId)?.order ?? null
  }

  const unitFullLabel = (stratumId: string): string => {
    const stratum = strata.value.find((item) => item.id === stratumId)
    if (!stratum) return '未知单位'
    const trench = trenches.value.find((item) => item.id === stratum.trenchId)
    const prefix = trench ? `${trench.area}·${trench.code}` : '未知探方'
    return `${prefix} / ${stratum.code}`
  }

  const violationTexts = computed(() =>
    violations.value.map((item) => formatViolation(item, periods.value, relations.value, unitFullLabel))
  )

  const boundsOf = (stratumId: string) =>
    periodBoundsOf(stratumId, strata.value, relations.value, periods.value, assignments.value)

  return { violations, conflictUnitIds, periodNameOf, periodOrderOf, unitFullLabel, violationTexts, boundsOf }
}
