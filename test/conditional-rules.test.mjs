import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearConditionalRulesCache,
  loadConditionalRules,
  parseFrontmatter,
} from '../shared/conditional-rules.mjs';

function makeTempRepo() {
  return mkdtempSync(join(tmpdir(), 'jev-cond-rules-'));
}

test('conditional-rules: parses minimal YAML frontmatter scalars, inline arrays, and block lists', () => {
  const raw = [
    '---',
    'name: UI Style Guide',
    'priority: 50',
    'always: false',
    'paths: src/ui/**, *.css',
    'keywords:',
    '  - styling',
    '  - layout',
    'tools: [edit, write]',
    '---',
    'Use CSS variables and avoid inline styles.',
  ].join('\n');

  const { frontmatter, body } = parseFrontmatter(raw);
  assert.equal(frontmatter.name, 'UI Style Guide');
  assert.equal(frontmatter.priority, 50);
  assert.equal(frontmatter.always, false);
  assert.equal(frontmatter.paths, 'src/ui/**, *.css');
  assert.deepEqual(frontmatter.keywords, ['styling', 'layout']);
  assert.deepEqual(frontmatter.tools, ['edit', 'write']);
  assert.equal(body, 'Use CSS variables and avoid inline styles.');
});

test('conditional-rules: discovers FOOTGUNS.md and .jev-footguns.md from parent to child with deduplication', () => {
  clearConditionalRulesCache();
  const repo = makeTempRepo();
  try {
    mkdirSync(join(repo, 'src', 'db', 'migrations'), { recursive: true });
    writeFileSync(join(repo, 'FOOTGUNS.md'), 'Root footgun: never commit secrets.', 'utf8');
    writeFileSync(join(repo, 'src', 'db', '.jev-footguns.md'), 'DB footgun: always use transactions.', 'utf8');
    writeFileSync(join(repo, 'src', 'db', 'migrations', 'FOOTGUNS.md'), 'Migration footgun: never drop columns directly.', 'utf8');
    writeFileSync(join(repo, 'src', 'db', 'migrations', '001_init.sql'), 'CREATE TABLE t (id INT);', 'utf8');
    writeFileSync(join(repo, 'src', 'db', 'migrations', '002_idx.sql'), 'CREATE INDEX idx ON t(id);', 'utf8');

    const res = loadConditionalRules({
      cwd: repo,
      activePaths: [
        'src/db/migrations/001_init.sql',
        join(repo, 'src', 'db', 'migrations', '002_idx.sql'),
      ],
    });

    assert.deepEqual(
      res.rules.map((r) => r.source),
      ['FOOTGUNS.md', 'src/db/.jev-footguns.md', 'src/db/migrations/FOOTGUNS.md']
    );
    assert.ok(res.totalBytes > 0);
    assert.equal(res.totalBytes, Buffer.byteLength(res.rendered, 'utf8'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('conditional-rules: mounts .jev/rules/*.md selectively by paths, keywords, tools, and always', () => {
  clearConditionalRulesCache();
  const repo = makeTempRepo();
  try {
    const rulesDir = join(repo, '.jev', 'rules');
    mkdirSync(rulesDir, { recursive: true });

    writeFileSync(
      join(rulesDir, '01-always.md'),
      ['---', 'name: Always On', 'priority: 10', 'always: true', '---', 'Always follow zero-dependency ESM.'].join('\n'),
      'utf8'
    );
    writeFileSync(
      join(rulesDir, '02-ui.md'),
      ['---', 'name: Frontend Rule', 'priority: 30', 'paths: src/ui/**, *.css', '---', 'Keep layout responsive.'].join('\n'),
      'utf8'
    );
    writeFileSync(
      join(rulesDir, '03-summary.md'),
      ['---', 'name: Summary Format', 'priority: 20', 'keywords:', '  - summarize', '  - report', '---', 'Use bullet points for summaries.'].join('\n'),
      'utf8'
    );
    writeFileSync(
      join(rulesDir, '04-shell.md'),
      ['---', 'name: Shell Guard', 'priority: 40', 'tools: [pwsh, bash]', '---', 'Verify exit codes after shell commands.'].join('\n'),
      'utf8'
    );

    // 1) Unmatched goal/paths/tools -> only always rule loads
    const minimal = loadConditionalRules({
      cwd: repo,
      goal: 'refactor database pool',
      activePaths: ['src/db/pool.mjs'],
      recentTools: ['read'],
    });
    assert.deepEqual(minimal.rules.map((r) => r.name), ['Always On']);

    // 2) Match paths (*.css) + keywords (SUMMARIZE case-insensitive) + tools (pwsh)
    const matched = loadConditionalRules({
      cwd: repo,
      goal: 'Please SUMMARIZE the button style changes',
      activePaths: ['packages/web/button.css'],
      recentTools: ['pwsh'],
    });

    // Sorted by priority desc: Shell Guard (40) > Frontend Rule (30) > Summary Format (20) > Always On (10)
    assert.deepEqual(
      matched.rules.map((r) => r.name),
      ['Shell Guard', 'Frontend Rule', 'Summary Format', 'Always On']
    );

    // 3) Byte-for-byte deterministic output regardless of input array order
    const matchedReordered = loadConditionalRules({
      cwd: repo,
      goal: 'Please SUMMARIZE the button style changes',
      activePaths: ['src/unrelated.mjs', 'packages/web/button.css'],
      recentTools: ['grep', 'pwsh'],
    });
    assert.equal(matched.rendered, matchedReordered.rendered);
    assert.equal(matched.totalBytes, matchedReordered.totalBytes);

    // 4) Cache invalidates when file mtimeMs changes
    const uiRulePath = join(rulesDir, '02-ui.md');
    writeFileSync(
      uiRulePath,
      ['---', 'name: Frontend Rule', 'priority: 30', 'paths: src/ui/**, *.css', '---', 'Updated responsive rule v2.'].join('\n'),
      'utf8'
    );
    const future = new Date(Date.now() + 5000);
    utimesSync(uiRulePath, future, future);

    const refreshed = loadConditionalRules({
      cwd: repo,
      activePaths: ['src/ui/card.mjs'],
    });
    const uiRule = refreshed.rules.find((r) => r.name === 'Frontend Rule');
    assert.equal(uiRule.text, 'Updated responsive rule v2.');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('conditional-rules: respects maxBytes budget cleanly without corrupting UTF-8', () => {
  clearConditionalRulesCache();
  const repo = makeTempRepo();
  try {
    const rulesDir = join(repo, '.jev', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, 'long.md'),
      ['---', 'name: Long Chinese Rule', 'always: true', '---', '这是一条非常长的中文规则内容，用于测试字节预算截断不会破坏多字节字符。'.repeat(20)].join('\n'),
      'utf8'
    );

    const res = loadConditionalRules({ cwd: repo, maxBytes: 260 });
    assert.ok(res.totalBytes <= 260);
    assert.equal(res.totalBytes, Buffer.byteLength(res.rendered, 'utf8'));
    assert.doesNotMatch(res.rendered, /\uFFFD/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
