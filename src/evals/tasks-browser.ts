import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startApp } from '../browser/app';
import { tokenize } from '../policy/command';
import { pluginRoot } from '../protocol/registry';
import { BASIC_CONFIG, PKG, mkPlan, write } from './helpers';
import { linkNodeModules } from './fixture';
import type { EvalTask } from './types';

const PW_CLI = (): string => join(pluginRoot(), 'node_modules', '@playwright', 'test', 'cli.js');

const SERVER = (bug: boolean): string => `const http=require('http'),fs=require('fs');
const items=[40,60];
http.createServer((q,r)=>{
  if(q.url==='/api/total'){r.setHeader('content-type','application/json');return r.end(JSON.stringify({total:items.reduce((a,b)=>a+b,0)${bug ? ' - 1' : ''}}))}
  r.setHeader('content-type','text/html');r.end(fs.readFileSync('public/index.html','utf8'))
}).listen(Number(process.argv[2]),'127.0.0.1');
`;
const INDEX_PLAIN = `<h1 id="total">loading</h1><script>fetch('/api/total').then(r=>r.json()).then(j=>{document.getElementById('total').textContent='Total: '+j.total})</script>`;
const INDEX_WITH_ADD = `<h1 id="total">loading</h1><button id="add">Add</button><span id="count">0</span><script>let n=0;document.getElementById('add').onclick=()=>{n++;document.getElementById('count').textContent=String(n)};fetch('/api/total').then(r=>r.json()).then(j=>{document.getElementById('total').textContent='Total: '+j.total})</script>`;
const SPEC_TOTAL = `const {test,expect}=require('@playwright/test');
test('shows the correct total @AC-1',async({page})=>{await page.goto(process.env.APP_URL);await expect(page.locator('#total')).toHaveText('Total: 100')});`;
const SPEC_ADD = `const {test,expect}=require('@playwright/test');
test('adds an item @AC-1',async({page})=>{await page.goto(process.env.APP_URL);await page.click('#add');await expect(page.locator('#count')).toHaveText('1')});`;
const PW_CONFIG = `module.exports={testDir:'e2e',timeout:20000,reporter:[['json',{outputFile:'pw-results.json'}]],use:{channel:'chrome',headless:true,trace:'on'}};`;

const WEB_PROTOCOL = `schemaVersion: 1
id: web-feature
version: 1.0.0
title: Web feature protocol
description: Feature or fix in a web app; the browser journey is required from medium risk.
engine: ">=0.7.0"
mode: existing-repo
defaultRisk: medium
retry: { maxRepairAttempts: 2, stopOnIdenticalFailure: true }
requiredArtifacts: [intent-brief, impact-map, acceptance-criteria, implementation-plan, test-plan, approved-plan-record]
personas: [ordinary-user]
gates:
  - { id: lint, kind: lint, required: true }
  - { id: typecheck, kind: typecheck, required: true }
  - { id: unit, kind: unit, required: true }
  - { id: build, kind: build, required: true }
  - { id: browser, kind: browser, required: true, minRisk: medium }
phases:
  - { id: intake, title: Classify the request }
  - { id: plan, title: Plan }
  - { id: approval, title: Human plan approval }
  - { id: implementation, title: Implement }
  - { id: verification, title: Run gates, gates: [lint, typecheck, unit, build, browser] }
  - { id: repair, title: Bounded repair loop }
  - { id: review, title: Independent review }
  - { id: delivery, title: Open the pull request with evidence }
`;

const files = (o: { bug: boolean; index: string; spec: string }): Record<string, string> => ({
  'package.json': PKG, 'check.js': 'process.exit(0)', 'server.js': SERVER(o.bug), 'public/index.html': o.index, 'e2e/app.spec.js': o.spec,
  'playwright.config.js': PW_CONFIG, '.gitignore': 'node_modules\ntest-results\npw-results.json\n',
});

/** The hidden acceptance for browser tasks: really run the app and Playwright against the final code. */
async function e2e(dir: string, port: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/`;
  let app;
  try {
    app = await startApp({ cwd: dir, start: `node server.js ${port}`, url, timeoutMs: 15_000, policy: { allowed: [tokenize('node')] } });
    execFileSync(process.execPath, [PW_CLI(), 'test'], { cwd: dir, stdio: 'pipe', timeout: 120_000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', APP_URL: url } });
    return true;
  } catch {
    return false;
  } finally {
    await app?.stop();
  }
}

function webTask(o: { id: string; intent: string; port: number; bug: boolean; index: string; spec: string; expect: 'verified' | 'blocked'; implement: EvalTask['implement']; personas?: string[]; modules: string[] }): EvalTask {
  return {
    id: o.id, category: 'browser', protocol: 'web-feature', intent: o.intent, expect: o.expect,
    files: files({ bug: o.bug, index: o.index, spec: o.spec }),
    plan: mkPlan({ summary: o.intent, modules: o.modules, acs: [{ id: 'AC-1', text: 'the page behaves as the end-to-end test requires', tests: ['e2e/app.spec.js'] }], tasks: [{ id: 'task-1', title: 'Make the page behave', scopes: o.modules, acs: ['AC-1'] }] }),
    implement: o.implement,
    acceptance: (d) => e2e(d, o.port),
    protocolYaml: { id: 'web-feature', yaml: WEB_PROTOCOL },
    setup: (root) => linkNodeModules(root, pluginRoot()),
    config: () => ({
      commands: { ...BASIC_CONFIG.commands, unit: 'node -e 0', browser: `node ${PW_CLI()} test` },
      app: { start: `node server.js ${o.port}`, url: `http://127.0.0.1:${o.port}/`, startTimeoutMs: 20_000, personas: o.personas ?? [], artifactDirs: ['test-results'], resultsFile: 'pw-results.json' } as never,
      limits: { gateTimeoutMs: 180_000 } as never,
    }),
  };
}

export const BROWSER_TASKS: EvalTask[] = [
  webTask({ id: 'browser-1-new-button-journey', intent: 'Add an Add button that counts clicks', port: 4871, bug: false, index: INDEX_PLAIN, spec: SPEC_ADD, expect: 'verified', modules: ['public/**'], personas: ['ordinary-user'], implement: (c) => write(c.cwd, 'public/index.html', INDEX_WITH_ADD) }),
  webTask({ id: 'browser-2-known-bug-fixed', intent: 'Fix the wrong total shown on the page', port: 4872, bug: true, index: INDEX_PLAIN, spec: SPEC_TOTAL, expect: 'verified', modules: ['server.js'], implement: (c) => write(c.cwd, 'server.js', SERVER(false)) }),
  webTask({ id: 'browser-3-known-bug-not-fixed', intent: 'Fix the wrong total shown on the page', port: 4873, bug: true, index: INDEX_PLAIN, spec: SPEC_TOTAL, expect: 'blocked', modules: ['server.js', 'public/**'], implement: (c) => write(c.cwd, 'public/index.html', `${INDEX_PLAIN}<!-- touched -->`) }),
];
