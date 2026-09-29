import type { Period, Relation, Stratum } from '@/types'

/** 单位 → 期别 id 的指派表（空串视为未定） */
export type PeriodAssignments = Record<string, string>

/** 有向时序边：from 叠压/打破 to（from 为前项，堆积更晚；to 为后项，堆积更早） */
export interface TemporalEdge {
  relationId: string
  from: string
  to: string
  type: Exclude<Relation['type'], '共存'>
}

export interface PeriodViolation {
  /** cycle：关系链绕回；conflict：与已有分期相抵 */
  kind: 'cycle' | 'conflict'
  /** 链上的单位 id：从「前项」（堆积更晚）到「后项」（堆积更早）；cycle 时首尾相接 */
  path: string[]
  /** 链上每一步对应的关系 id（长度 = path.length - 1） */
  relationIds: string[]
  /** 链尾后项（堆积更早）的期别序号；cycle 时为 -1 */
  earlierOrder: number
  /** 链首前项（堆积更晚）的期别序号；cycle 时为 -1 */
  laterOrder: number
}

/** 最简并查集：把「共存」单位并成同期组 */
class UnionFind {
  private parent = new Map<string, string>()

  constructor(ids: Iterable<string>) {
    for (const id of ids) this.parent.set(id, id)
  }

  find(id: string): string {
    const current = this.parent.get(id) ?? id
    if (current === id) return id
    const root = this.find(current)
    this.parent.set(id, root)
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

interface AdjEdge {
  relationId: string
  type: TemporalEdge['type']
  /** 折叠后的目标组根（等于起点即自环） */
  toRoot: string
}

export interface TemporalModel {
  edges: TemporalEdge[]
  /** 共存组根 → 组内单位 */
  groups: Map<string, string[]>
  /** 单位 → 组根 */
  rootOf: Map<string, string>
  /** 组级邻接表（自环 toRoot 等于起点） */
  adjacency: Map<string, AdjEdge[]>
}

/**
 * 构建时序模型：
 * - 共存（同期等价）用并查集并组，不产生有向边，故不会把两个同期单位误判为绕回；
 * - 叠压/打破边折叠到共存组之间；组内若再出现叠压/打破（A 共存 B 又 A 打破 B）即为矛盾自环。
 */
export function buildTemporalModel(strata: Stratum[], relations: Relation[]): TemporalModel {
  const unitIds = strata.map((item) => item.id)
  const uf = new UnionFind(unitIds)
  relations.forEach((relation) => {
    if (relation.type === '共存') uf.union(relation.unitAId, relation.unitBId)
  })

  const rootOf = new Map<string, string>()
  const groups = new Map<string, string[]>()
  unitIds.forEach((id) => {
    const root = uf.find(id)
    rootOf.set(id, root)
    const list = groups.get(root) ?? []
    list.push(id)
    groups.set(root, list)
  })

  const known = new Set(unitIds)
  const edges: TemporalEdge[] = []
  const adjacency = new Map<string, AdjEdge[]>()
  groups.forEach((_, root) => adjacency.set(root, []))

  relations.forEach((relation) => {
    if (relation.type === '共存') return
    if (!known.has(relation.unitAId) || !known.has(relation.unitBId)) return
    edges.push({ relationId: relation.id, from: relation.unitAId, to: relation.unitBId, type: relation.type })
    const rFrom = rootOf.get(relation.unitAId) as string
    const rTo = rootOf.get(relation.unitBId) as string
    adjacency.get(rFrom)?.push({ relationId: relation.id, type: relation.type, toRoot: rTo })
  })

  return { edges, groups, rootOf, adjacency }
}

/** 兼容旧调用：单位级有向边（共存不展开双向，避免伪环） */
export function buildTemporalEdges(relations: Relation[]): TemporalEdge[] {
  return relations
    .filter((relation) => relation.type !== '共存')
    .map((relation) => ({
      relationId: relation.id,
      from: relation.unitAId,
      to: relation.unitBId,
      type: relation.type as Exclude<Relation['type'], '共存'>
    }))
}

/**
 * 跨探方联合分期核验，沿关系链检查：
 * 1. 绕回（环）：叠压/打破关系在共存组之间自相闭合（含「同期却又互相叠压/打破」的自环），任何分期都无法成立；
 * 2. 相抵：关系链上「前项（堆积更晚，链首）」的期别反而早于「后项（堆积更早，链尾）」。
 *
 * 期别 order 越小年代越早；沿 A→B（A 叠压/打破 B）须满足 order(A) ≥ order(B)。
 * 共存单位视为同期；未定单位不参与期别相抵判断。
 */
export function validatePhasing(
  strata: Stratum[],
  relations: Relation[],
  periods: Period[],
  assignments: PeriodAssignments
): { violations: PeriodViolation[] } {
  const { groups, rootOf, adjacency } = buildTemporalModel(strata, relations)

  const orderOfPeriod = new Map<string, number>()
  periods.forEach((period) => orderOfPeriod.set(period.id, period.order))

  const violations: PeriodViolation[] = []
  const seenCycleKeys = new Set<string>()
  const seenConflictKeys = new Set<string>()

  const representative = (root: string): string => (groups.get(root) ?? [root]).slice().sort()[0]

  // 1. 组级环检测（DFS 着色）。DFS 仅记录根路径与关系 id，
  //    检测到环后按关系端点重放具体单位序列（同组多成员也能对齐）。
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  groups.forEach((_, root) => color.set(root, WHITE))
  const rootStack: string[] = []
  const edgeStack: string[] = []

  /** 按根环 + 关系序列重放单位路径：边 r.unitAId∈前根组、r.unitBId∈后根组 */
  const buildCycleNodes = (cycleRoots: string[], cycleEdges: string[]): string[] => {
    const relationById = new Map(relations.map((item) => [item.id, item]))
    const nodes: string[] = []
    cycleRoots.forEach((root, index) => {
      const relationId = cycleEdges[index]
      const relation = relationById.get(relationId)
      if (!relation) {
        nodes.push(representative(root))
        return
      }
      const fromInGroup = rootOf.get(relation.unitAId) === root ? relation.unitAId : representative(root)
      nodes.push(fromInGroup)
    })
    return nodes
  }

  const visit = (root: string): void => {
    color.set(root, GRAY)
    rootStack.push(root)
    for (const edge of adjacency.get(root) ?? []) {
      if (edge.toRoot === root) {
        // 自环：共存组内部又出现叠压/打破（同期却分出先后）
        const selfRelation = relations.find((item) => item.id === edge.relationId)
        if (selfRelation) {
          const key = `self:${edge.relationId}`
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key)
            violations.push({
              kind: 'cycle',
              path: [selfRelation.unitAId, selfRelation.unitBId],
              relationIds: [edge.relationId],
              earlierOrder: -1,
              laterOrder: -1
            })
          }
        }
        continue
      }
      const state = color.get(edge.toRoot) ?? WHITE
      if (state === GRAY) {
        const index = rootStack.indexOf(edge.toRoot)
        const cycleRoots = [...rootStack.slice(index), edge.toRoot].slice(0, -1)
        const cycleEdges = [...edgeStack.slice(index), edge.relationId]
        const key = canonicalKey(rootStack.slice(index).map(representative))
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key)
          violations.push({
            kind: 'cycle',
            path: buildCycleNodes(cycleRoots, cycleEdges),
            relationIds: cycleEdges,
            earlierOrder: -1,
            laterOrder: -1
          })
        }
      } else if (state === WHITE) {
        edgeStack.push(edge.relationId)
        visit(edge.toRoot)
        edgeStack.pop()
      }
    }
    rootStack.pop()
    color.set(root, BLACK)
  }

  groups.forEach((_, root) => {
    if ((color.get(root) ?? WHITE) === WHITE) visit(root)
  })

  // 2. 期别相抵：单位级图上枚举已分期单位对（共存补双向同期边）
  const unitAdj = new Map<string, { to: string; relationId: string }[]>()
  strata.forEach((item) => unitAdj.set(item.id, []))
  relations.forEach((relation) => {
    if (!unitAdj.has(relation.unitAId) || !unitAdj.has(relation.unitBId)) return
    if (relation.type === '共存') {
      unitAdj.get(relation.unitAId)?.push({ to: relation.unitBId, relationId: relation.id })
      unitAdj.get(relation.unitBId)?.push({ to: relation.unitAId, relationId: relation.id })
    } else {
      unitAdj.get(relation.unitAId)?.push({ to: relation.unitBId, relationId: relation.id })
    }
  })

  const phased = strata.filter((item) => {
    const periodId = assignments[item.id]
    return Boolean(periodId) && orderOfPeriod.has(periodId)
  })

  for (const front of phased) {
    for (const back of phased) {
      if (front.id === back.id) continue
      const laterOrder = orderOfPeriod.get(assignments[front.id]) as number
      const earlierOrder = orderOfPeriod.get(assignments[back.id]) as number
      if (laterOrder >= earlierOrder) continue
      const found = findPath(front.id, back.id, unitAdj)
      if (!found) continue
      const key = `${canonicalKey(found.nodes)}:${laterOrder}<${earlierOrder}`
      if (seenConflictKeys.has(key)) continue
      seenConflictKeys.add(key)
      violations.push({
        kind: 'conflict',
        path: found.nodes,
        relationIds: found.relationIds,
        earlierOrder,
        laterOrder
      })
    }
  }

  violations.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'cycle' ? -1 : 1
    return b.earlierOrder - b.laterOrder - (a.earlierOrder - a.laterOrder)
  })
  return { violations }
}

/** 深度优先搜索：start → target 的有向路径 */
function findPath(
  start: string,
  target: string,
  adjacency: Map<string, { to: string; relationId: string }[]>
): { nodes: string[]; relationIds: string[] } | null {
  const visited = new Set<string>([start])
  const nodes: string[] = [start]
  const relationIds: string[] = []

  const dfs = (node: string): boolean => {
    if (node === target) return true
    for (const edge of adjacency.get(node) ?? []) {
      if (visited.has(edge.to)) continue
      visited.add(edge.to)
      nodes.push(edge.to)
      relationIds.push(edge.relationId)
      if (dfs(edge.to)) return true
      nodes.pop()
      relationIds.pop()
    }
    return false
  }

  return dfs(start) ? { nodes: [...nodes], relationIds: [...relationIds] } : null
}

/** 路径归一化键（旋转到最小元素开头），避免同一环/同一路径重复上报 */
function canonicalKey(nodes: string[]): string {
  if (nodes.length === 0) return ''
  let minIndex = 0
  for (let i = 1; i < nodes.length; i += 1) {
    if (nodes[i] < nodes[minIndex]) minIndex = i
  }
  return [...nodes.slice(minIndex), ...nodes.slice(0, minIndex)].join('>')
}

/** 单位在关系链上允许的期别序号区间（供编辑单个单位时提示） */
export interface PeriodBounds {
  /** 期别序号下限（本单位为前项时，后项最早不过此值）；无约束为 null */
  minOrder: number | null
  /** 期别序号上限（本单位为后项时，前项最晚不过此值）；无约束为 null */
  maxOrder: number | null
}

/**
 * 计算单个单位允许的期别序号区间（含端点）。共存组成员同期，指派互相约束：
 * - 本单位 → 他单位（他为后项）：order(本) ≥ order(他)，给出下限；
 * - 他单位 → 本单位（他为前项）：order(本) ≤ order(他)，给出上限。
 */
export function periodBoundsOf(
  unitId: string,
  strata: Stratum[],
  relations: Relation[],
  periods: Period[],
  assignments: PeriodAssignments
): PeriodBounds {
  const model = buildTemporalModel(strata, relations)
  const orderOfPeriod = new Map<string, number>()
  periods.forEach((period) => orderOfPeriod.set(period.id, period.order))

  const root = model.rootOf.get(unitId)
  const peers = (root ? model.groups.get(root) ?? [unitId] : [unitId]).filter((id) => id !== unitId)
  const peerOrders = peers
    .map((id) => assignments[id])
    .filter((periodId): periodId is string => Boolean(periodId) && orderOfPeriod.has(periodId))
    .map((periodId) => orderOfPeriod.get(periodId) as number)

  let minOrder = peerOrders.length ? Math.min(...peerOrders) : null
  let maxOrder = peerOrders.length ? Math.max(...peerOrders) : null

  const orderFor = (id: string): number | null => {
    const periodId = assignments[id]
    if (!periodId || !orderOfPeriod.has(periodId)) return null
    return orderOfPeriod.get(periodId) as number
  }

  model.edges.forEach((edge) => {
    if (edge.from === unitId) {
      const value = orderFor(edge.to)
      if (value !== null) minOrder = minOrder === null ? value : Math.max(minOrder, value)
    }
    if (edge.to === unitId) {
      const value = orderFor(edge.from)
      if (value !== null) maxOrder = maxOrder === null ? value : Math.min(maxOrder, value)
    }
  })
  return { minOrder, maxOrder }
}

/** 把核验结果渲染成具体单位与关系路径的文本；unitLabel 由调用方提供（可带探方号） */
export function formatViolation(
  violation: PeriodViolation,
  periods: Period[],
  relations: Relation[],
  unitLabel: (id: string) => string
): string {
  const typeOf = (relationId: string): string => relations.find((item) => item.id === relationId)?.type ?? '关系'
  const chain = violation.path
    .map((id, index) => (index === 0 ? unitLabel(id) : `${typeOf(violation.relationIds[index - 1])} → ${unitLabel(id)}`))
    .join(' ')
  const periodName = (order: number): string => periods.find((item) => item.order === order)?.name ?? `第 ${order + 1} 期`

  if (violation.kind === 'cycle') {
    return `关系链绕回：${chain} →（回到 ${unitLabel(violation.path[0])}），叠压/打破关系自相闭合，任何分期都不成立`
  }
  return `期别相抵：${chain}；前项 ${unitLabel(violation.path[0])}（${periodName(
    violation.laterOrder
  )}）的期别早于后项 ${unitLabel(violation.path[violation.path.length - 1])}（${periodName(
    violation.earlierOrder
  )}），违反「前项期别不晚于后项」，请调整期别或核对关系`
}
