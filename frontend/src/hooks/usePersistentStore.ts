import { onUnmounted, reactive } from 'vue'
import type { StoreApi } from 'zustand/vanilla'
import Dexie, { type Table } from 'dexie'
import type { Artifact, Period, Relation, Stratum, Trench } from '@/types'

/** IndexedDB 数据结构版本号 */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/** 单位 → 期别 指派行（每个地层单位至多一行） */
export interface AssignmentRow {
  stratumId: string
  periodId: string
}

/** Dexie 封装：探方 / 地层单位 / 出土物 / 层位关系 / 期别 / 分期指派 六张表 + 元数据表 */
class TrenchLogDb extends Dexie {
  trenches!: Table<Trench, string>
  strata!: Table<Stratum, string>
  artifacts!: Table<Artifact, string>
  relations!: Table<Relation, string>
  periods!: Table<Period, string>
  assignments!: Table<AssignmentRow, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('gbtrenchlog')
    this.version(1).stores({
      trenches: 'id, code, area',
      strata: 'id, trenchId, code, type',
      artifacts: 'id, stratumId, code, category',
      relations: 'id, unitAId, unitBId, type',
      meta: 'key'
    })
    // v2：地层单位新增「开口层位」字段，迁移时为历史数据补齐默认值
    this.version(2)
      .stores({
        trenches: 'id, code, area, backfilled',
        strata: 'id, trenchId, code, type, topDepth',
        artifacts: 'id, stratumId, code, category, date',
        relations: 'id, unitAId, unitBId, type, basis',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Stratum, string>('strata')
          .toCollection()
          .modify((stratum) => {
            if (!stratum.openLayer) {
              stratum.openLayer = '第①层'
            }
            if (!Array.isArray(stratum.inclusions)) {
              stratum.inclusions = []
            }
          })
      })
    // v3：跨探方联合分期，新增「期别」与「单位分期指派」两张表
    this.version(SCHEMA_VERSION).stores({
      trenches: 'id, code, area, backfilled',
      strata: 'id, trenchId, code, type, topDepth',
      artifacts: 'id, stratumId, code, category, date',
      relations: 'id, unitAId, unitBId, type, basis',
      periods: 'id, order, name',
      assignments: 'stratumId, periodId',
      meta: 'key'
    })
  }
}

export const db = new TrenchLogDb()

/** 写入当前数据结构版本号 */
export async function stampDbVersion(): Promise<void> {
  await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
}

/** 读取整表 */
export async function syncAll<T extends object>(table: Table<T, string>): Promise<T[]> {
  return table.toArray()
}

/** 写入一条记录 */
export async function syncPut<T extends object>(table: Table<T, string>, row: T): Promise<void> {
  await table.put(row)
}

/** 删除一条记录 */
export async function syncDelete<T extends object>(table: Table<T, string>, id: string): Promise<void> {
  await table.delete(id)
}

/** Zustand vanilla store → Vue 响应式桥接 */
export function useStore<T extends object>(store: StoreApi<T>): T {
  const state = reactive({ ...store.getState() }) as T
  const unsubscribe = store.subscribe((next: T) => {
    Object.assign(state, next)
  })
  onUnmounted(() => unsubscribe())
  return state
}

/** 首次打开写入示例数据 */
export async function seedDemoData(): Promise<void> {
  const count = await db.trenches.count()
  if (count > 0) return

  const today = new Date().toISOString().slice(0, 10)

  await db.trenches.bulkPut([
    {
      id: 'tr_0501',
      code: 'T0501',
      area: 'Ⅱ区',
      size: '5×5 米',
      basePoint: 'N1200 / E3000',
      openLayer: '第①层',
      startDate: today,
      endDate: '',
      leader: '方铭',
      wallNote: '北壁、东壁保存较好；南壁被现代扰坑破坏',
      backfilled: false
    },
    {
      id: 'tr_0502',
      code: 'T0502',
      area: 'Ⅱ区',
      size: '5×5 米',
      basePoint: 'N1205 / E3000',
      openLayer: '第①层',
      startDate: today,
      endDate: today,
      leader: '方铭',
      wallNote: '四壁规整，西壁可见 H12 剖面',
      backfilled: true
    }
  ])

  await db.strata.bulkPut([
    {
      id: 'st_0501_l1',
      trenchId: 'tr_0501',
      code: 'L01',
      type: '地层',
      openLayer: '第①层',
      topDepth: 0,
      bottomDepth: 0.25,
      soil: '灰褐色砂质黏土，疏松',
      inclusions: ['陶片', '炭屑'],
      formation: '近现代耕土层',
      date: today,
      drawingNo: 'T0501-北壁-01'
    },
    {
      id: 'st_0501_l2',
      trenchId: 'tr_0501',
      code: 'L02',
      type: '地层',
      openLayer: '第②层',
      topDepth: 0.25,
      bottomDepth: 0.6,
      soil: '黄褐色黏土，致密',
      inclusions: ['陶片', '骨'],
      formation: '汉代文化层',
      date: today,
      drawingNo: 'T0501-北壁-02'
    },
    {
      id: 'st_0501_h12',
      trenchId: 'tr_0501',
      code: 'H12',
      type: '灰坑',
      openLayer: '第②层下',
      topDepth: 0.6,
      bottomDepth: 1.4,
      soil: '深灰褐土，含大量灰烬',
      inclusions: ['陶片', '骨', '炭屑'],
      formation: '生活垃圾坑',
      date: today,
      drawingNo: 'T0501-H12-平剖面'
    },
    {
      id: 'st_0502_l1',
      trenchId: 'tr_0502',
      code: 'L01',
      type: '地层',
      openLayer: '第①层',
      topDepth: 0,
      bottomDepth: 0.3,
      soil: '灰褐色砂质黏土',
      inclusions: ['陶片'],
      formation: '耕土层',
      date: today,
      drawingNo: 'T0502-西壁-01'
    },
    {
      id: 'st_0502_l2',
      trenchId: 'tr_0502',
      code: 'L02',
      type: '地层',
      openLayer: '第②层',
      topDepth: 0.3,
      bottomDepth: 0.7,
      soil: '黄褐色黏土，致密，与 T0501 第②层土质一致',
      inclusions: ['陶片', '骨'],
      formation: '汉代文化层（西延接 T0501）',
      date: today,
      drawingNo: 'T0502-西壁-02'
    },
    {
      id: 'st_0502_h22',
      trenchId: 'tr_0502',
      code: 'H22',
      type: '灰坑',
      openLayer: '第②层下',
      topDepth: 0.7,
      bottomDepth: 1.3,
      soil: '深灰褐土，含灰烬与红烧土块',
      inclusions: ['陶片', '炭屑'],
      formation: '生活垃圾坑',
      date: today,
      drawingNo: 'T0502-H22-平剖面'
    }
  ])

  await db.artifacts.bulkPut([
    {
      id: 'af_001',
      stratumId: 'st_0501_l2',
      code: 'T0501②:1',
      category: '陶器',
      count: 3,
      completeness: '残片',
      x: 2.4,
      y: 1.8,
      z: 0.42,
      date: today,
      collector: '祁野',
      tempLocation: '工地临时柜 A-2'
    },
    {
      id: 'af_002',
      stratumId: 'st_0501_h12',
      code: 'T0501H12:1',
      category: '骨器',
      count: 1,
      completeness: '可复原',
      x: 3.1,
      y: 3.6,
      z: 1.05,
      date: today,
      collector: '祁野',
      tempLocation: '工地临时柜 A-3'
    }
  ])

  await db.relations.bulkPut([
    {
      id: 'rl_001',
      unitAId: 'st_0501_h12',
      type: '打破',
      unitBId: 'st_0501_l2',
      basis: '剖面观察',
      recorder: '方铭',
      note: 'H12 开口于第②层下，打破 L02'
    },
    {
      id: 'rl_002',
      unitAId: 'st_0501_l1',
      type: '叠压',
      unitBId: 'st_0501_l2',
      basis: '剖面观察',
      recorder: '方铭',
      note: 'L01 叠压 L02，界面清晰'
    },
    {
      id: 'rl_003',
      unitAId: 'st_0502_h22',
      type: '打破',
      unitBId: 'st_0502_l2',
      basis: '剖面观察',
      recorder: '方铭',
      note: 'T0502 西壁 H22 开口于第②层下，打破本探方 L02'
    },
    {
      id: 'rl_004',
      unitAId: 'st_0502_h22',
      type: '叠压',
      unitBId: 'st_0501_h12',
      basis: '平面观察',
      recorder: '方铭',
      note: '跨方对照：T0502 H22 坑底堆积物与 T0501 H12 上层填土可衔接，H22 堆积略晚'
    },
    {
      id: 'rl_005',
      unitAId: 'st_0501_l2',
      type: '共存',
      unitBId: 'st_0502_l2',
      basis: '平面观察',
      recorder: '方铭',
      note: '跨方对照：两方第②层土质土色一致，为同一汉代文化层面'
    }
  ])

  await db.periods.bulkPut([
    { id: 'pd_1', name: '一期', order: 0, note: '汉代文化层（最早）' },
    { id: 'pd_2', name: '二期', order: 1, note: '汉代灰坑 H12 / H22' },
    { id: 'pd_3', name: '三期', order: 2, note: '近现代耕土层（最晚）' }
  ])

  await db.assignments.bulkPut([
    { stratumId: 'st_0501_l2', periodId: 'pd_1' },
    { stratumId: 'st_0502_l2', periodId: 'pd_1' },
    { stratumId: 'st_0501_h12', periodId: 'pd_2' },
    { stratumId: 'st_0502_h22', periodId: 'pd_2' },
    { stratumId: 'st_0501_l1', periodId: 'pd_3' },
    { stratumId: 'st_0502_l1', periodId: 'pd_3' }
  ])
}
