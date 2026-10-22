import type { Store } from '../state/store';

export const TOPICS = [
  { id: 'outcome', question: 'What business outcome should this achieve, and how will you know it worked?' },
  { id: 'users', question: 'Who are the primary users, and what are they doing today instead?' },
  { id: 'pain', question: 'What is the single most painful part of the current process?' },
  { id: 'integrations', question: 'Which existing tools or data sources must it connect to?' },
  { id: 'constraints', question: 'Are there fixed constraints: budget, deadline, team skills, hosting, compliance?' },
  { id: 'scale', question: 'What usage do you expect at launch and in 12 months (users, records, requests)?' },
  { id: 'success', question: 'What measurable target defines success for the first release?' },
] as const;
export type TopicId = (typeof TOPICS)[number]['id'];

export interface Answer {
  text: string;
  source: 'user' | 'default' | 'inferred';
}

export type InterviewState = Partial<Record<TopicId, Answer>>;

/** Conservative defaults, used only when the user says "you decide". They surface as visible assumptions. */
export const DEFAULTS: Record<TopicId, string> = {
  outcome: 'Reduce manual effort in the core workflow and make its status visible',
  users: 'Small internal teams using the product daily',
  pain: 'Work is scattered across tools and nothing shows the current state',
  integrations: 'None required for the first release; add integrations after the MVP',
  constraints: 'No fixed deadline; standard managed hosting; small team',
  scale: 'Up to a few hundred users and tens of thousands of records in the first year',
  success: 'Core workflow completes end to end in the product by a pilot group',
};

const key = (runId: string): string => `interview:${runId}`;

export function loadInterview(store: Store, runId: string): InterviewState {
  const raw = store.getKey(key(runId));
  return raw ? (JSON.parse(raw) as InterviewState) : {};
}

export function recordAnswer(store: Store, runId: string, topic: TopicId, a: Answer): InterviewState {
  const state = loadInterview(store, runId);
  const prior = state[topic];
  if (prior && prior.source === 'user' && a.source !== 'user') return state; // never overwrite what the user said
  state[topic] = a;
  store.setKey(key(runId), JSON.stringify(state));
  store.audit(runId, 'interview.answer', a.source === 'user' ? 'human:interview' : 'engine', { topic, source: a.source });
  return state;
}

export const unanswered = (state: InterviewState): TopicId[] => TOPICS.filter((t) => !state[t.id]).map((t) => t.id);

/** One focused question at a time; anything already provided (even in the first sentence) is never asked again. */
export function nextQuestion(state: InterviewState): { topic: TopicId; question: string } | null {
  const t = TOPICS.find((x) => !state[x.id]);
  return t ? { topic: t.id, question: t.question } : null;
}

/** "Decide for me": fill the remaining topics with defaults; every default is returned as an assumption to confirm. */
export function fillDefaults(store: Store, runId: string): Array<{ topic: TopicId; text: string }> {
  const filled: Array<{ topic: TopicId; text: string }> = [];
  for (const topic of unanswered(loadInterview(store, runId))) {
    recordAnswer(store, runId, topic, { text: DEFAULTS[topic], source: 'default' });
    filled.push({ topic, text: DEFAULTS[topic] });
  }
  return filled;
}

export const isInterviewComplete = (state: InterviewState): boolean => unanswered(state).length === 0;
