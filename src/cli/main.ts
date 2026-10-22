import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { EXIT, runCli } from './index';

const io = {
  out: (t: string): void => void process.stdout.write(t),
  err: (t: string): void => void process.stderr.write(t),
  stdin: (): string => {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      return '';
    }
  },
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm: (q: string): boolean => {
    process.stderr.write(`${q} [y/N] `);
    const fd = openSync('/dev/tty', 'r');
    const buf = Buffer.alloc(1);
    let line = '';
    try {
      while (readSync(fd, buf, 0, 1, null) === 1 && buf.toString() !== '\n') line += buf.toString();
    } finally {
      closeSync(fd);
    }
    return /^y(es)?$/i.test(line.trim());
  },
};

runCli(process.argv.slice(2), { cwd: process.cwd(), env: process.env, io }).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(EXIT.error);
  },
);
