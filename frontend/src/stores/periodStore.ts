import { createStore } from 'zustand/vanilla'
import type { Period } from '@/types'
import { db, syncAll, syncDelete, syncPut, type AssignmentRow } from '@/hooks/usePersistentStore'

export interface PeriodState {
  periods: Period[]
  /** 单位 id → 期别 id（未分期不在表中） */
  assignments: Record<string, string>
  loaded: boolean
  hydrate: () => Promise<void>
  savePeriod: (period: Period) => Promise<void>
  removePeriod: (id: string) => Promise<void>
  /** 上移：把期别向更早的方向调整（order 减 1） */
  moveEarlier: (id: string) => Promise<void>
  /** 下移：把期别向更晚的方向调整（order 加 1） */
  moveLater: (id: string) => Promise<void>
  assign: (stratumId: string, periodId: string) => Promise<void>
  /** 批量指派（草稿确认时一次写入，传完整指派表） */
  bulkAssign: (assignments: Record<string, string>) => Promise<void>
  removeAssignmentsByStratum: (stratumId: string) => Promise<void>
}

export const periodStore = createStore<PeriodState>((set, get) => ({
  periods: [],
  assignments: {},
  loaded: false,
  hydrate: async () => {
    const periods = await syncAll<Period>(db.periods)
    periods.sort((a, b) => a.order - b.order)
    const rows = await syncAll<AssignmentRow>(db.assignments)
    const assignments: Record<string, string> = {}
    rows.forEach((row) => {
      assignments[row.stratumId] = row.periodId
    })
    set({ periods, assignments, loaded: true })
  },
  savePeriod: async (period) => {
    await syncPut<Period>(db.periods, period)
    await get().hydrate()
  },
  removePeriod: async (id) => {
    await syncDelete<Period>(db.periods, id)
    const stale = (await syncAll<AssignmentRow>(db.assignments)).filter((row) => row.periodId === id)
    await Promise.all(stale.map((row) => db.assignments.delete(row.stratumId)))
    await get().hydrate()
  },
  moveEarlier: async (id) => {
    const sorted = [...get().periods].sort((a, b) => a.order - b.order)
    const index = sorted.findIndex((item) => item.id === id)
    if (index <= 0) return
    const current = sorted[index]
    const previous = sorted[index - 1]
    await syncPut<Period>(db.periods, { ...current, order: previous.order })
    await syncPut<Period>(db.periods, { ...previous, order: current.order })
    await get().hydrate()
  },
  moveLater: async (id) => {
    const sorted = [...get().periods].sort((a, b) => a.order - b.order)
    const index = sorted.findIndex((item) => item.id === id)
    if (index < 0 || index >= sorted.length - 1) return
    const current = sorted[index]
    const next = sorted[index + 1]
    await syncPut<Period>(db.periods, { ...current, order: next.order })
    await syncPut<Period>(db.periods, { ...next, order: current.order })
    await get().hydrate()
  },
  assign: async (stratumId, periodId) => {
    if (periodId) {
      await db.assignments.put({ stratumId, periodId })
    } else {
      await db.assignments.delete(stratumId)
    }
    await get().hydrate()
  },
  bulkAssign: async (assignments) => {
    // 单事务整体替换，避免确认过程中断留下半截指派
    await db.transaction('rw', db.assignments, async () => {
      await db.assignments.clear()
      await db.assignments.bulkPut(
        Object.entries(assignments)
          .filter(([, periodId]) => periodId)
          .map(([stratumId, periodId]) => ({ stratumId, periodId }))
      )
    })
    await get().hydrate()
  },
  removeAssignmentsByStratum: async (stratumId) => {
    await db.assignments.delete(stratumId)
    await get().hydrate()
  }
}))
