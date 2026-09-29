import { computed, ref, watch } from 'vue'

/**
 * 跨页面共享的期别筛选：关系图与剖面按所选期别联动。
 * 模块级单例，单页内各路由共用；选择写入 localStorage，重开浏览器仍保留。
 */
const STORAGE_KEY = 'gbtrenchlog:phaseFilter'

function readStored(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null || raw === '') return null
    const num = Number(raw)
    return Number.isInteger(num) && num >= 1 ? num : null
  } catch {
    return null
  }
}

const selectedPhase = ref<number | null>(readStored())

watch(selectedPhase, (value) => {
  try {
    if (value === null) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    /* localStorage 不可用时仅在当前会话生效 */
  }
})

/** 关系图 / 剖面等页面共用的「按所选期别联动」筛选 */
export function usePhaseFilter() {
  const active = computed(() => selectedPhase.value)

  function setPhase(value: number | null): void {
    selectedPhase.value = value
  }

  /** 判断某单位在当前期别筛选下是否应被弱化展示 */
  function dimmedByPhase(phase: number | null | undefined): boolean {
    if (selectedPhase.value === null) return false
    return phase !== selectedPhase.value
  }

  /** 从单位期别集合派生可选期别（升序） */
  function optionsOf(phases: (number | null | undefined)[]): number[] {
    const set = new Set<number>()
    phases.forEach((phase) => {
      if (typeof phase === 'number' && Number.isInteger(phase) && phase >= 1) set.add(phase)
    })
    return Array.from(set).sort((a, b) => a - b)
  }

  return { active, setPhase, dimmedByPhase, optionsOf }
}
