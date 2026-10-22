import { PlError } from '../shared/errors';

export interface DagNode {
  id: string;
  dependencies: readonly string[];
}

/** Kahn topological order; throws with the offending cycle path so authors can fix it. */
export function topoSort<T extends DagNode>(nodes: readonly T[]): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) for (const d of n.dependencies) if (!byId.has(d)) throw new PlError('PL_DAG_001', `"${n.id}" depends on unknown "${d}"`);
  const state = new Map<string, 'visiting' | 'done'>();
  const order: T[] = [];
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') throw new PlError('PL_DAG_002', `dependency cycle: ${[...path.slice(path.indexOf(id)), id].join(' -> ')}`);
    state.set(id, 'visiting');
    for (const d of byId.get(id)!.dependencies) visit(d, [...path, id]);
    state.set(id, 'done');
    order.push(byId.get(id)!);
  };
  for (const n of nodes) visit(n.id, []);
  return order;
}

export function transitiveDeps(nodes: readonly DagNode[], id: string): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const walk = (x: string): void => {
    for (const d of byId.get(x)?.dependencies ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      walk(d);
    }
  };
  walk(id);
  return seen;
}

/** Nodes whose dependencies are all in `done` and that are not themselves done/running. */
export function readyNodes<T extends DagNode>(nodes: readonly T[], done: ReadonlySet<string>, started: ReadonlySet<string>): T[] {
  return nodes.filter((n) => !started.has(n.id) && !done.has(n.id) && n.dependencies.every((d) => done.has(d)));
}
