import { execFileSync } from 'node:child_process';

const suites = [
  'units.mjs', 'preview.mjs', 'bash.mjs', 'socketpath.mjs', 'config.mjs',
  'install.mjs', 'server.mjs', 'roundtrip.mjs', 'hook.mjs',
];
let failed = 0;

for (const s of suites) {
  try {
    execFileSync('node', [`test/${s}`], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} suite(s) failed`);
  process.exit(1);
}
console.log('\nall suites passed');
