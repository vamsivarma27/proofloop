import type { Plan } from '../src/plan/schema';

export function validPlan(over: Partial<Plan> = {}): Plan {
  return {
    schemaVersion: 1,
    intent: { summary: 'Add pagination to users', outcome: 'Users page shows 20 per page', constraints: [], nonGoals: ['infinite scroll'] },
    assumptions: [{ id: 'A-1', text: 'API supports limit/offset', impact: 'medium', confirmed: true }],
    affectedModules: [{ path: 'src/users/list.ts', reason: 'renders the list', status: 'confirmed' }],
    acceptanceCriteria: [{ id: 'AC-1', text: 'Page shows at most 20 users', tests: ['tests/users.test.ts'] }],
    testPlan: [{ id: 'T-1', kind: 'unit', description: 'pagination slices correctly', gateId: 'unit' }],
    risk: { level: 'medium', rationale: 'UI and API touched' },
    tasks: [{ id: 'task-1', title: 'Paginate', description: 'Add limit/offset', dependencies: [], fileScopes: ['src/users/**'], acceptanceCriteria: ['AC-1'], risk: 'medium', doneWhen: 'tests pass' }],
    gateCommands: {},
    ...over,
  } as Plan;
}
