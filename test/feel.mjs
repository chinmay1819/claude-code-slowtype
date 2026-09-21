#!/usr/bin/env node
// Types a sample to the terminal using the real pacing model, so the cadence can
// be tuned without rebuilding the extension host every time.
//
//   node test/feel.mjs                       # built-in sample
//   node test/feel.mjs src/foo.ts            # a real file
//   node test/feel.mjs --cps 30 --expr 1.6   # tune
import fs from 'node:fs';
import { Typist, estimateMs } from '../extension/out/pacing.js';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(argv[i + 1]);
};
const file = argv.find((a) => !a.startsWith('--') && !/^[\d.]+$/.test(a));

const SAMPLE = `export async function loadUser(id: string): Promise<User | null> {
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }

  const row = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  if (!row) return null;

  const user = { id: row.id, name: row.name, email: row.email };
  cache.set(id, user);
  return user;
}
`;

const text = file ? fs.readFileSync(file, 'utf8') : SAMPLE;
const opts = { charsPerSecond: flag('cps', 10), expressiveness: flag('expr', 1) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(
  `\x1b[2m${opts.charsPerSecond} c/s, expressiveness ${opts.expressiveness}, ` +
  `${text.length} chars, est ${(estimateMs(text, opts) / 1000).toFixed(1)}s\x1b[0m\n`
);

const t = new Typist(text, opts);
const started = Date.now();
let longest = { ms: 0, at: '' };

while (!t.done) {
  const from = t.position;
  const { chunk, delayMs } = t.next();
  process.stdout.write(text.slice(from, from + chunk));
  if (delayMs > longest.ms) {
    longest = { ms: delayMs, at: JSON.stringify(text.slice(Math.max(0, from - 12), from + 4)) };
  }
  await sleep(delayMs);
}

const actual = (Date.now() - started) / 1000;
console.log(
  `\n\x1b[2m--- ${actual.toFixed(1)}s actual, ` +
  `${(text.length / actual).toFixed(0)} c/s effective, ` +
  `longest pause ${longest.ms.toFixed(0)}ms after ${longest.at}\x1b[0m`
);
