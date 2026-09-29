import type { Relation, RelationType, Stratum } from '@/types'

export interface GraphEdge {
  id: string
  from: string
  to: string
  type: RelationType
  basis: string
  /** 是否为有向时序边（叠压/打破为 true，共存为 false） */
  directed: boolean
  /** 是否处于被检测出的环路中 */
  inCycle: boolean
}

export interface GraphNode {
  id: string
  label: string
  sublabel: string
  /** 拓扑层次（0 为最上层，越小越靠上） */
  layer: number
  type: Stratum['type']
}

export interface DirectedGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 邻接表：节点 → 直接后继（叠压/打破） */
  adjacency: Map<string, string[]>
  /** 反向邻接表 */
  reverse: Map<string, string[]>
  /** 无向邻居表（共存关系，不参与时序与环路判断） */
  neighbors: Map<string, string[]>
  /** 是否存在环路 */
  hasCycle: boolean
  /** 环路路径（节点 id 序列） */
  cyclePath: string[]
}

/** 构建有向图（叠压/打破 A→B 表示 A 晚于 B；共存按无向同期连接，不产生时序方向故不会误判为环） */
export function buildGraph(strata: Stratum[], relations: Relation[]): DirectedGraph {
  const adjacency = new Map<string, string[]>()
  const reverse = new Map<string, string[]>()
  const neighbors = new Map<string, string[]>()
  strata.forEach((item) => {
    adjacency.set(item.id, [])
    reverse.set(item.id, [])
    neighbors.set(item.id, [])
  })

  const edges: GraphEdge[] = []
  relations.forEach((relation) => {
    if (!adjacency.has(relation.unitAId) || !adjacency.has(relation.unitBId)) return
    if (relation.type === '共存') {
      neighbors.get(relation.unitAId)?.push(relation.unitBId)
      neighbors.get(relation.unitBId)?.push(relation.unitAId)
      edges.push({
        id: `${relation.id}#0`,
        from: relation.unitAId,
        to: relation.unitBId,
        type: relation.type,
        basis: relation.basis,
        directed: false,
        inCycle: false
      })
      return
    }
    adjacency.get(relation.unitAId)?.push(relation.unitBId)
    reverse.get(relation.unitBId)?.push(relation.unitAId)
    edges.push({
      id: `${relation.id}#0`,
      from: relation.unitAId,
      to: relation.unitBId,
      type: relation.type,
      basis: relation.basis,
      directed: true,
      inCycle: false
    })
  })

  const cyclePath = findCycle(adjacency)
  const cycleNodes = new Set(cyclePath)
  const hasCycle = cyclePath.length > 0
  const cycleEdges = new Set<string>()
  if (hasCycle) {
    for (let i = 0; i < cyclePath.length; i += 1) {
      const from = cyclePath[i]
      const to = cyclePath[(i + 1) % cyclePath.length]
      cycleEdges.add(`${from}->${to}`)
    }
  }
  edges.forEach((edge) => {
    edge.inCycle = cycleEdges.has(`${edge.from}->${edge.to}`) || (cycleNodes.has(edge.from) && cycleNodes.has(edge.to) && cycleEdges.size === 0)
  })

  const layers = topoLayers(adjacency, strata.map((item) => item.id))
  const nodes: GraphNode[] = strata.map((stratum) => ({
    id: stratum.id,
    label: stratum.code,
    sublabel: `${stratum.type} · ${stratum.topDepth}–${stratum.bottomDepth} m`,
    layer: layers.get(stratum.id) ?? 0,
    type: stratum.type
  }))

  return { nodes, edges, adjacency, reverse, neighbors, hasCycle, cyclePath }
}

/** 环路检测（DFS，返回环路路径；无环返回空数组） */
export function findCycle(adjacency: Map<string, string[]>): string[] {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  adjacency.forEach((_, key) => color.set(key, WHITE))
  const stack: string[] = []
  let cycle: string[] = []

  const visit = (node: string): boolean => {
    color.set(node, GRAY)
    stack.push(node)
    const next = adjacency.get(node) ?? []
    for (const child of next) {
      const state = color.get(child) ?? WHITE
      if (state === GRAY) {
        const index = stack.indexOf(child)
        cycle = stack.slice(index >= 0 ? index : 0)
        return true
      }
      if (state === WHITE && visit(child)) return true
    }
    stack.pop()
    color.set(node, BLACK)
    return false
  }

  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE && visit(node)) break
  }
  return cycle
}

/** 拓扑层次分层：layer(v) = 1 + max(layer(前驱))，带环时按深度截断 */
export function topoLayers(adjacency: Map<string, string[]>, nodeIds: string[]): Map<string, number> {
  const layers = new Map<string, number>()
  const visiting = new Set<string>()

  const depth = (node: string): number => {
    if (layers.has(node)) return layers.get(node) as number
    if (visiting.has(node)) return 0
    visiting.add(node)
    const predecessors = Array.from(adjacency.entries())
      .filter(([, next]) => next.includes(node))
      .map(([key]) => key)
    const value = predecessors.length === 0 ? 0 : Math.max(...predecessors.map((item) => depth(item) + 1))
    visiting.delete(node)
    layers.set(node, value)
    return value
  }

  nodeIds.forEach((id) => depth(id))
  return layers
}

/** 判断新增关系是否会形成环路（用于保存前校验）；共存为无向同期关系，不产生时序方向 */
export function wouldCreateCycle(relations: Relation[], candidate: Pick<Relation, 'unitAId' | 'unitBId' | 'type'>): boolean {
  const adjacency = new Map<string, string[]>()
  const push = (from: string, to: string): void => {
    const list = adjacency.get(from) ?? []
    list.push(to)
    adjacency.set(from, list)
  }
  relations.forEach((relation) => {
    if (relation.type !== '共存') push(relation.unitAId, relation.unitBId)
  })
  if (candidate.type !== '共存') push(candidate.unitAId, candidate.unitBId)
  return findCycle(adjacency).length > 0
}

/** 取某个节点的直接关系（用于点击高亮；含共存邻居） */
export function directRelations(graph: DirectedGraph, nodeId: string): { outgoing: string[]; incoming: string[] } {
  return {
    outgoing: graph.adjacency.get(nodeId) ?? [],
    incoming: graph.reverse.get(nodeId) ?? []
  }
}

/** 高亮子图：节点本身 + 直接前后继 + 共存邻居 */
export function highlightSubgraph(graph: DirectedGraph, nodeId: string | null): Set<string> {
  if (!nodeId) return new Set()
  const { outgoing, incoming } = directRelations(graph, nodeId)
  const peers = graph.neighbors.get(nodeId) ?? []
  return new Set<string>([nodeId, ...outgoing, ...incoming, ...peers])
}
