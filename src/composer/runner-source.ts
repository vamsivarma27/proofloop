/**
 * Source of the sandbox child. It runs under `node --permission` (no fs writes, no child processes, no network,
 * no workers) with an empty environment, and can only reach the host through these JSON-line messages.
 */
export const RUNNER_SOURCE = String.raw`
import { createInterface } from 'node:readline';
const send = (m, cb) => process.stdout.write(JSON.stringify(m) + '\n', cb);
const finish = (m) => send(m, () => process.exit(0));
const pending = new Map();
let nextId = 1;
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'result') {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (p) msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error));
    return;
  }
  if (msg.type !== 'program' || started) return;
  started = true;
  const tools = {};
  for (const name of msg.tools) {
    const [ns, fn] = name.split('.');
    tools[ns] ??= {};
    tools[ns][fn] = (args) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ type: 'call', id, name, args: args ?? {} });
    });
  }
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('tools', msg.code);
    const value = await fn(tools);
    finish({ type: 'done', value: value === undefined ? null : value });
  } catch (e) {
    finish({ type: 'error', message: String(e && e.message ? e.message : e) });
  }
});
`;
