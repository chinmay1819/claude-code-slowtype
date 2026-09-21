// Bash write detection. These are the command shapes Claude Code actually uses.
import assert from 'node:assert';
import { candidateWrites, diffSnapshot } from '../extension/out/bash.js';

const ROOT = '/proj';
const find = (cmd, cwd = ROOT) => candidateWrites(cmd, cwd, ROOT).sort();
const has = (cmd, p, cwd = ROOT) =>
  assert.ok(find(cmd, cwd).includes(p), `${JSON.stringify(cmd)} should target ${p}\n  got ${find(cmd, cwd)}`);
const lacks = (cmd, p) =>
  assert.ok(!find(cmd).includes(p), `${JSON.stringify(cmd)} should NOT target ${p}`);

// --- the shapes that matter -------------------------------------------------
has("cat > src/app.ts <<'EOF'\nconst x = 1;\nEOF", '/proj/src/app.ts');
has('cat >> notes.md <<EOF\nhi\nEOF', '/proj/notes.md');
has('echo "hello" > out.txt', '/proj/out.txt');
has("printf '%s' foo > a/b/c.js", '/proj/a/b/c.js');
has('some-generator | tee generated.ts', '/proj/generated.ts');
has('gen | tee -a log.txt', '/proj/log.txt');
has("sed -i '' 's/a/b/' src/config.ts", '/proj/src/config.ts');
has("sed -i.bak 's/x/y/g' Makefile.am", '/proj/Makefile.am');
has('cp template.ts src/new.ts', '/proj/src/new.ts');
has('mv old.ts src/renamed.ts', '/proj/src/renamed.ts');
has('touch src/empty.ts', '/proj/src/empty.ts');
has('python3 gen.py schema.json', '/proj/schema.json');
has('node build.mjs', '/proj/build.mjs');

// Relative to the command's cwd, not the project root.
has('cat > local.ts <<EOF\nx\nEOF', '/proj/sub/local.ts', '/proj/sub');

// --- things we must not touch ----------------------------------------------
lacks('cat > /etc/hosts <<EOF\nx\nEOF', '/etc/hosts');
lacks('cat ../../outside.ts', '/outside.ts');
lacks('npm install > package-lock.json', '/proj/package-lock.json');
lacks('cp a.png dist/b.png', '/proj/dist/b.png');
lacks('echo x > node_modules/foo/index.js', '/proj/node_modules/foo/index.js');
lacks('rm -rf build > /dev/null', '/dev/null');
lacks('cmd 2>&1', '/proj/&1');
lacks('cat > "$TARGET" <<EOF\nx\nEOF', '/proj/$TARGET');
lacks('rm *.ts > out.log 2>&1', '/proj/*.ts');

// A read-only command should find nothing worth animating.
assert.deepStrictEqual(find('grep -r "foo" .'), [], 'grep targets nothing');
assert.deepStrictEqual(find('ls -la'), [], 'ls targets nothing');
assert.deepStrictEqual(find('git status'), [], 'git status targets nothing');

// Multiple targets in one command.
{
  const got = find("echo a > one.ts && echo b > two.ts");
  assert.ok(got.includes('/proj/one.ts') && got.includes('/proj/two.ts'), got);
}

// --- snapshot diffing -------------------------------------------------------
{
  const snap = { files: new Map([
    ['/proj/created.ts', null],
    ['/proj/changed.ts', 'old'],
    ['/proj/same.ts', 'same'],
    ['/proj/gone.ts', 'was here'],
  ]) };
  const now = {
    '/proj/created.ts': 'brand new',
    '/proj/changed.ts': 'new',
    '/proj/same.ts': 'same',
    '/proj/gone.ts': null,
  };
  const changes = diffSnapshot(snap, (p) => now[p] ?? null);
  const byPath = Object.fromEntries(changes.map((c) => [c.filePath, c]));

  assert.strictEqual(changes.length, 2, `only real changes replay, got ${changes.map(c=>c.filePath)}`);
  assert.deepStrictEqual(byPath['/proj/created.ts'], {
    filePath: '/proj/created.ts', before: null, after: 'brand new',
  });
  assert.deepStrictEqual(byPath['/proj/changed.ts'], {
    filePath: '/proj/changed.ts', before: 'old', after: 'new',
  });
  assert.ok(!byPath['/proj/same.ts'], 'untouched files are not replayed');
  assert.ok(!byPath['/proj/gone.ts'], 'deleted files are not replayed');
}

console.log('ok  bash write detection');
