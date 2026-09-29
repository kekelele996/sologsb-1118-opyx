import type { Relation, RelationType, Stratum } from '@/types'
import { topoLayers } from '@/utils/graph'

/** 关系链上的一步：经由哪条关系、什么类型 */
export interface PhasePathStep {
  relationId: string
  type: RelationType
}

/** 一期分期核验问题 */
export interface PhaseIssue {
  /**
   * conflict：期别相抵（叠压/打破链上前项晚于后项）；
   * coexistence：共存单位期别不一致；
   * cycle：关系链绕回（环路）
   */
  kind: 'conflict' | 'coexistence' | 'cycle'
  /** 单位 id 序列（路径节点） */
  unitIds: string[]
  /** 与 unitIds 等长 - 1 的关系步（cycle 时闭合步也在其中） */
  steps: PhasePathStep[]
  /** conflict 时链首单位的期别（较大、反而偏晚） */
  startPhase?: number
  /** conflict 时链尾单位的期别（较小、反而偏早） */
  endPhase?: number
}

interface PhaseEdge extends PhasePathStep {
  from: string
  to: string
}

const CN_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/** 期别文案：第X期 / 未分期 */
export function phaseLabel(phase: number | null | undefined): string {
  if (phase === null || phase === undefined) return '未分期'
  return `第${phase >= 1 && phase <= 10 ? CN_NUMERALS[phase - 1] : phase}期`
}

/**
 * 构建分期核验邻接表：
 * - 叠压/打破：A→B 单向，约束 期别(A) ≤ 期别(B)；
 * - 共存：单独收集（按无向处理），约束双方期别相等。
 * 仅纳入当前仍存在的地层单位。
 */
export function buildPhaseAdjacency(strata: Stratum[], relations: Relation[]): Map<string, PhaseEdge[]> {
  const adjacency = new Map<string, PhaseEdge[]>()
  strata.forEach((item) => adjacency.set(item.id, []))
  relations.forEach((relation) => {
    if (!adjacency.has(relation.unitAId) || !adjacency.has(relation.unitBId)) return
    if (relation.type === '共存') return
    adjacency
      .get(relation.unitAId)
      ?.push({ relationId: relation.id, type: relation.type, from: relation.unitAId, to: relation.unitBId })
  })
  return adjacency
}

/** 共存关系（无向，要求同期） */
export function coexistencePairs(relations: Relation[]): Relation[] {
  return relations.filter((relation) => relation.type === '共存')
}

/** 环路检测：返回第一条绕回路径（含闭合步） */
export function detectPhaseCycle(adjacency: Map<string, PhaseEdge[]>): PhaseIssue | null {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  adjacency.forEach((_, key) => color.set(key, WHITE))

  const nodeStack: string[] = []
  const edgeStack: PhasePathStep[] = []
  let issue: PhaseIssue | null = null

  const visit = (node: string): boolean => {
    color.set(node, GRAY)
    nodeStack.push(node)
    for (const edge of adjacency.get(node) ?? []) {
      const state = color.get(edge.to) ?? WHITE
      if (state === GRAY) {
        const index = nodeStack.indexOf(edge.to)
        const unitIds = nodeStack.slice(index)
        const steps = [...edgeStack.slice(index), { relationId: edge.relationId, type: edge.type }]
        issue = { kind: 'cycle', unitIds, steps }
        return true
      }
      if (state === WHITE) {
        edgeStack.push({ relationId: edge.relationId, type: edge.type })
        if (visit(edge.to)) return true
        edgeStack.pop()
      }
    }
    nodeStack.pop()
    color.set(node, BLACK)
    return false
  }

  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE && visit(node)) break
  }
  return issue
}

/**
 * 沿关系链核验期别（只走叠压/打破单向边）：
 * 对每个已分期单位 u，沿 叠压/打破 链可达的已分期单位 v，
 * 必须满足 期别(u) ≤ 期别(v)；否则记录一条「期别相抵」问题，
 * 并保留触发矛盾的完整单位/关系路径。
 */
export function findPhaseConflicts(
  adjacency: Map<string, PhaseEdge[]>,
  phases: Map<string, number | null>
): PhaseIssue[] {
  const issues: PhaseIssue[] = []
  const seen = new Set<string>()

  const assigned = (id: string): number | null => phases.get(id) ?? null

  adjacency.forEach((_, source) => {
    const sourcePhase = assigned(source)
    if (sourcePhase === null) return
    const visited = new Set<string>([source])
    const nodePath = [source]
    const edgePath: PhasePathStep[] = []

    const walk = (node: string): void => {
      for (const edge of adjacency.get(node) ?? []) {
        if (visited.has(edge.to)) continue
        visited.add(edge.to)
        nodePath.push(edge.to)
        edgePath.push({ relationId: edge.relationId, type: edge.type })

        const targetPhase = assigned(edge.to)
        if (targetPhase !== null && targetPhase < (sourcePhase as number)) {
          const dedupKey = `${source}->${edge.to}`
          if (!seen.has(dedupKey)) {
            seen.add(dedupKey)
            issues.push({
              kind: 'conflict',
              unitIds: [...nodePath],
              steps: [...edgePath],
              startPhase: sourcePhase as number,
              endPhase: targetPhase
            })
          }
        }
        walk(edge.to)

        edgePath.pop()
        nodePath.pop()
      }
    }
    walk(source)
  })

  return issues
}

/** 共存（同期）单位若双方都已定级却期别不一致，逐条列出 */
export function findCoexistenceMismatches(
  relations: Relation[],
  phases: Map<string, number | null>,
  exists: (id: string) => boolean
): PhaseIssue[] {
  const issues: PhaseIssue[] = []
  coexistencePairs(relations).forEach((relation) => {
    if (!exists(relation.unitAId) || !exists(relation.unitBId)) return
    const phaseA = phases.get(relation.unitAId) ?? null
    const phaseB = phases.get(relation.unitBId) ?? null
    if (phaseA === null || phaseB === null || phaseA === phaseB) return
    issues.push({
      kind: 'coexistence',
      unitIds: [relation.unitAId, relation.unitBId],
      steps: [{ relationId: relation.id, type: '共存' }],
      startPhase: phaseA,
      endPhase: phaseB
    })
  })
  return issues
}

/** 全量核验：先查绕回，再查期别相抵、共存同期 */
export function validatePhases(strata: Stratum[], relations: Relation[], phases: Map<string, number | null>): PhaseIssue[] {
  const adjacency = buildPhaseAdjacency(strata, relations)
  const cycle = detectPhaseCycle(adjacency)
  const conflicts = findPhaseConflicts(adjacency, phases)
  const exists = (id: string): boolean => strata.some((item) => item.id === id)
  const coexist = findCoexistenceMismatches(relations, phases, exists)
  return cycle ? [cycle, ...conflicts, ...coexist] : [...conflicts, ...coexist]
}

/**
 * 按关系链自动建议期别（编号越大越早）：
 * 拓扑分层 layer(v)=1+max(前驱 layer)，建议期别 = layer + 1；
 * 未参与任何叠压/打破关系的孤立单位不给建议（留给记录员判断）。
 */
export function suggestPhases(strata: Stratum[], relations: Relation[]): Map<string, number> {
  const adjacency = new Map<string, string[]>()
  const incident = new Set<string>()
  strata.forEach((item) => adjacency.set(item.id, []))
  relations.forEach((relation) => {
    if (relation.type === '共存') return
    if (!adjacency.has(relation.unitAId) || !adjacency.has(relation.unitBId)) return
    adjacency.get(relation.unitAId)?.push(relation.unitBId)
    incident.add(relation.unitAId)
    incident.add(relation.unitBId)
  })

  const layers = topoLayers(adjacency, strata.map((item) => item.id))
  const result = new Map<string, number>()
  incident.forEach((id) => {
    result.set(id, (layers.get(id) ?? 0) + 1)
  })
  return result
}
