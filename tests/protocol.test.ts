import { describe, expect, it } from 'vitest';
import { engineSatisfies, loadRegistry, parseProtocol } from '../src/protocol/registry';
import { ENGINE_VERSION } from '../src/version';
import pkg from '../package.json';

const minimal = (extra = '') => `
schemaVersion: 1
id: demo
version: 1.0.0
title: Demo
description: Demo protocol
engine: ">=0.1.0"
mode: existing-repo
defaultRisk: low
gates:
  - { id: unit, kind: unit, required: true }
phases:
  - { id: verification, title: Verify, gates: [unit] }
  - { id: delivery, title: Deliver }
${extra}`;

describe('protocol schema', () => {
  it('keeps ENGINE_VERSION in sync with package.json', () => {
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  it('loads every built-in protocol without diagnostics', () => {
    const reg = loadRegistry();
    expect(reg.diagnostics).toEqual([]);
    expect(reg.list().map((p) => p.id)).toEqual(
      ['bug', 'feature', 'idea-to-product', 'performance', 'refactor', 'security', 'test', 'troubleshooting', 'verify'],
    );
  });

  it('accepts a minimal valid protocol', () => {
    expect(parseProtocol(minimal()).diagnostics).toEqual([]);
  });

  it('reports YAML syntax errors with a line number', () => {
    const { diagnostics } = parseProtocol('id: [unclosed\n');
    expect(diagnostics[0]?.line).toBeGreaterThan(0);
  });

  it('rejects unknown keys and bad ids with a path', () => {
    const { diagnostics } = parseProtocol(minimal('bogus: 1').replace('id: demo', 'id: Not_Kebab'));
    const paths = diagnostics.map((d) => d.path);
    expect(paths).toContain('id');
  });

  it('rejects unknown gate references', () => {
    const src = minimal().replace('gates: [unit] }', 'gates: [nope] }');
    expect(parseProtocol(src).diagnostics.map((d) => d.message).join()).toContain('unknown gate "nope"');
  });

  it('refuses to let verification or delivery be skipped', () => {
    const src = minimal().replace('title: Deliver }', 'title: Deliver, skipped: { reason: because I said so, really } }');
    expect(parseProtocol(src).diagnostics.map((d) => d.message).join()).toContain('can never be skipped');
  });

  it('requires a real reason for skipped phases', () => {
    const src = minimal('  - { id: review, title: R, skipped: { reason: no } }');
    expect(parseProtocol(src).diagnostics.map((d) => d.message).join()).toContain('real reason');
  });

  it('requires an unskipped review for high-risk protocols', () => {
    const src = minimal().replace('defaultRisk: low', 'defaultRisk: high');
    expect(parseProtocol(src).diagnostics.map((d) => d.message).join()).toContain('review');
  });

  it('rejects protocols that need a newer engine', () => {
    const src = minimal().replace('>=0.1.0', '>=99.0.0');
    expect(parseProtocol(src).diagnostics[0]?.path).toBe('engine');
    expect(engineSatisfies('>=1.0.0', '1.0.0-rc.1')).toBe(true);
    expect(engineSatisfies('>=1.1.0', '1.0.0')).toBe(false);
  });
});
