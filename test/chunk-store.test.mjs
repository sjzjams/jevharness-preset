import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChunkStore } from '../shared/chunk-store.mjs';

test('chunk-store: addChunk assigns stable IDs, generates summaries, and deduplicates by session+source+hash', () => {
  const store = createChunkStore();
  const sampleText = [
    'import { createServer } from "node:http";',
    'export function startServer(port) {',
    '  if (!port) throw new Error("port required");',
    '  return createServer().listen(port);',
    '}',
  ].join('\n');

  const c1 = store.addChunk('sess-1', {
    kind: 'file_read',
    access: 'read',
    sensitivity: 'internal',
    source: 'src/server.mjs',
    turn: 1,
    step: 1,
    fullText: sampleText,
  });

  assert.equal(c1.id, 'c1');
  assert.equal(c1.sessionId, 'sess-1');
  assert.equal(c1.kind, 'file_read');
  assert.equal(c1.access, 'read');
  assert.equal(c1.sensitivity, 'internal');
  assert.equal(c1.visibility, 'short_summary');
  assert.equal(c1.lines, 5);
  assert.equal(c1.chars, sampleText.length);
  assert.ok(c1.shortSummary.length <= 240);
  assert.ok(c1.longSummary.length <= 1200);
  assert.equal(c1.fullText, sampleText);

  // Exact same session + source + content should deduplicate and reuse ID c1
  const dup = store.addChunk('sess-1', {
    kind: 'file_read',
    source: 'src/server.mjs',
    fullText: sampleText,
  });
  assert.equal(dup.id, 'c1');
  assert.equal(store.stats('sess-1').totalChunks, 1);

  // Same content with different source gets new ID c2
  const c2 = store.addChunk('sess-1', {
    kind: 'file_read',
    source: 'src/server-copy.mjs',
    fullText: sampleText,
  });
  assert.equal(c2.id, 'c2');
  assert.equal(store.stats('sess-1').totalChunks, 2);

  // Same source & content in a different session gets its own ID c1
  const otherSess = store.addChunk('sess-2', {
    kind: 'file_read',
    source: 'src/server.mjs',
    fullText: sampleText,
  });
  assert.equal(otherSess.id, 'c1');
});

test('chunk-store: visibility ladder switches across 4 levels and compresses without deleting', () => {
  const store = createChunkStore();
  const lines = Array.from({ length: 120 }, (_, i) =>
    i === 60
      ? 'ERROR: critical assertion failed at handler.mjs:61'
      : `line ${i + 1}: routine diagnostic output payload value=${i * 17}`
  );
  const fullText = lines.join('\n');

  const chunk = store.addChunk('vis-sess', {
    kind: 'command_output',
    access: 'read',
    sensitivity: 'internal',
    source: 'npm test',
    fullText,
  });

  assert.ok(chunk.shortSummary.length <= 240);
  assert.ok(chunk.longSummary.length <= 1200);
  assert.match(chunk.longSummary, /ERROR: critical assertion failed/);

  // 1) Switch to hide: fullText is preserved and still recoverable via readChunk
  const hideRes = store.applyVisibility('vis-sess', { [chunk.id]: 'hide' });
  assert.deepEqual(hideRes.updated, ['c1']);

  const digestHidden = store.renderDigest('vis-sess');
  assert.match(digestHidden, /Hidden \(recallable via jev_chunk_read, not deleted\): 1 \[c1\]/);
  assert.doesNotMatch(digestHidden, /routine diagnostic output/);

  // Recall on demand from hidden chunk with paging
  const slice1 = store.readChunk('vis-sess', 'c1', { level: 'full', offset: 0, limit: 500 });
  assert.equal(slice1.visibility, 'hide');
  assert.equal(slice1.text, fullText.slice(0, 500));
  assert.equal(slice1.hasMore, true);
  assert.equal(slice1.nextOffset, 500);

  const slice2 = store.readChunk('vis-sess', 'c1', { level: 'full', offset: 500, limit: 10000 });
  assert.equal(slice1.text + slice2.text, fullText);
  assert.equal(slice2.hasMore, false);

  // 2) Switch to short_summary -> long_summary -> full
  for (const level of ['short_summary', 'long_summary', 'full']) {
    store.applyVisibility('vis-sess', { c1: level });
    const fetched = store.getChunk('vis-sess', 'c1');
    assert.equal(fetched.visibility, level);
    const readBack = store.readChunk('vis-sess', 'c1', { level, limit: fullText.length });
    if (level === 'short_summary') assert.equal(readBack.text, fetched.shortSummary);
    if (level === 'long_summary') assert.equal(readBack.text, fetched.longSummary);
    if (level === 'full') {
      assert.equal(readBack.text, fullText);
      const defaultPaged = store.readChunk('vis-sess', 'c1', { level: 'full' });
      assert.equal(defaultPaged.returnedChars, 4000);
      assert.equal(defaultPaged.hasMore, true);
    }
  }

  // listMetadata excludes fullText
  const meta = store.listMetadata('vis-sess', { limit: 10 });
  assert.equal(meta.length, 1);
  assert.equal('fullText' in meta[0], false);
  assert.equal(meta[0].id, 'c1');
  assert.equal(meta[0].visibility, 'full');
});

test('chunk-store: LRU eviction only evicts oldest hidden non-critical chunks', () => {
  const store = createChunkStore({ maxChunksPerSession: 3 });

  // c1: non-critical, will be hidden (oldest)
  store.addChunk('lru', { kind: 'search_result', source: 'grep1', fullText: 'hit 1', visibility: 'hide' });
  // c2: critical (user_turn), hidden — must NOT be evicted
  store.addChunk('lru', { kind: 'user_turn', source: 'user', fullText: 'do not delete me', visibility: 'hide' });
  // c3: non-critical, visible — must NOT be evicted
  store.addChunk('lru', { kind: 'tool_output', source: 'tool3', fullText: 'visible output', visibility: 'short_summary' });
  // Adding c4 triggers eviction of c1
  store.addChunk('lru', { kind: 'tool_output', source: 'tool4', fullText: 'newest output', visibility: 'short_summary' });

  assert.equal(store.getChunk('lru', 'c1'), null);
  assert.ok(store.getChunk('lru', 'c2'));
  assert.ok(store.getChunk('lru', 'c3'));
  assert.ok(store.getChunk('lru', 'c4'));
  assert.equal(store.stats('lru').evictedCount, 1);
});

test('chunk-store: exportRetrievalPack filters by sensitivity and stays read-only within budget', () => {
  const store = createChunkStore();
  store.addChunk('pack', {
    kind: 'repo_fact',
    sensitivity: 'public',
    source: 'README.md',
    fullText: 'Public documentation overview',
    visibility: 'full',
  });
  store.addChunk('pack', {
    kind: 'file_read',
    sensitivity: 'internal',
    source: 'src/app.mjs',
    fullText: 'export const appVersion = "2.0.0";',
    visibility: 'long_summary',
  });
  store.addChunk('pack', {
    kind: 'file_read',
    sensitivity: 'sensitive',
    source: 'infra/prod.yaml',
    fullText: 'internal_endpoint: https://prod.corp.local',
    visibility: 'full',
  });
  store.addChunk('pack', {
    kind: 'file_read',
    sensitivity: 'secret',
    source: '.env',
    fullText: 'API_SECRET_KEY=sk-live-super-secret-9999',
    visibility: 'full',
  });

  const internalPack = store.exportRetrievalPack('pack', { maxSensitivity: 'internal', maxChars: 6000 });
  assert.equal(internalPack.readOnly, true);
  assert.equal(internalPack.includedCount, 2);
  assert.equal(internalPack.excludedBySensitivity, 2);
  assert.deepEqual(
    internalPack.chunks.map((c) => c.sensitivity).sort(),
    ['internal', 'public']
  );
  assert.doesNotMatch(internalPack.rendered, /sk-live-super-secret/);
  assert.doesNotMatch(internalPack.rendered, /prod\.corp\.local/);

  const publicPack = store.exportRetrievalPack('pack', { maxSensitivity: 'public', maxChars: 6000 });
  assert.equal(publicPack.includedCount, 1);
  assert.equal(publicPack.excludedBySensitivity, 3);
  assert.equal(publicPack.chunks[0].source, 'README.md');
});

test('chunk-store: optional persistDir round-trips session chunks across store instances', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'jev-chunk-store-'));
  try {
    const storeA = createChunkStore({ persistDir: tmp });
    storeA.addChunk('persist-sess', {
      kind: 'repo_fact',
      source: 'package.json',
      fullText: '{"name":"jev"}',
      visibility: 'long_summary',
    });

    const storeB = createChunkStore({ persistDir: tmp });
    const loaded = storeB.getChunk('persist-sess', 'c1');
    assert.ok(loaded);
    assert.equal(loaded.fullText, '{"name":"jev"}');
    assert.equal(loaded.visibility, 'long_summary');

    storeB.clearSession('persist-sess');
    const storeC = createChunkStore({ persistDir: tmp });
    assert.equal(storeC.getChunk('persist-sess', 'c1'), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
