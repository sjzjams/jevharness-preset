import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubgoalTracker, jaccardSimilarity, tokenizeText } from '../shared/subgoal-tracker.mjs';

test('subgoal-tracker: tokenizes Chinese and English text accurately for Jaccard similarity', () => {
  const a = tokenizeText('重构 shared/chunk-store.mjs 状态存储模块');
  const b = tokenizeText('重构 shared/chunk-store.mjs 状态存储模块！');
  assert.equal(jaccardSimilarity(a, b), 1);

  const c = tokenizeText('分析 database migration 性能瓶颈');
  assert.ok(jaccardSimilarity(a, c) < 0.2);
});

test('subgoal-tracker: detects duplicate subgoals for both in_flight and completed states', () => {
  const tracker = createSubgoalTracker();

  const reg = tracker.registerSubgoal('s1', {
    id: 'sg-auth',
    description: 'Audit auth middleware token verification',
    prompt: 'Inspect src/auth/verify.mjs for JWT expiry checks',
    access: 'read',
    paths: ['src/auth/verify.mjs'],
  });
  assert.equal(reg.registered, true);
  assert.equal(reg.conflict, false);

  // Near-identical in_flight subgoal -> blocked as duplicate
  const dupInFlight = tracker.checkDuplicate('s1', {
    description: 'Audit auth middleware token verification',
    prompt: 'Inspect src/auth/verify.mjs for JWT expiry checks!',
    paths: ['src/auth/verify.mjs'],
  });
  assert.equal(dupInFlight.duplicate, true);
  assert.equal(dupInFlight.status, 'in_flight');
  assert.equal(dupInFlight.existing.id, 'sg-auth');
  assert.ok(dupInFlight.similarity >= 0.78);

  // Different subgoal -> not duplicate
  const distinct = tracker.checkDuplicate('s1', {
    description: 'Benchmark Redis cache latency',
    prompt: 'Profile cache hit ratio in src/cache/redis.mjs',
    paths: ['src/cache/redis.mjs'],
  });
  assert.equal(distinct.duplicate, false);

  // Mark completed -> duplicate check still catches already-completed work
  tracker.completeSubgoal('s1', 'sg-auth', {
    status: 'completed',
    summary: 'Verified exp/nbf checks exist.',
  });

  const dupCompleted = tracker.checkDuplicate('s1', {
    description: 'Audit auth middleware token verification',
    prompt: 'Inspect src/auth/verify.mjs for JWT expiry checks',
    paths: ['src/auth/verify.mjs'],
  });
  assert.equal(dupCompleted.duplicate, true);
  assert.equal(dupCompleted.status, 'completed');
  assert.equal(dupCompleted.existing.summary, 'Verified exp/nbf checks exist.');

  // Chinese duplicate detection
  tracker.registerSubgoal('s1', {
    id: 'sg-cn',
    description: '检查条件规则模块的前端路径匹配逻辑',
    prompt: '阅读 shared/conditional-rules.mjs 并核对 glob 规则',
    access: 'read',
    paths: ['shared/conditional-rules.mjs'],
  });
  const dupCn = tracker.checkDuplicate('s1', {
    description: '检查条件规则模块的前端路径匹配逻辑',
    prompt: '阅读 shared/conditional-rules.mjs 并核对 glob 规则',
    paths: ['shared/conditional-rules.mjs'],
  });
  assert.equal(dupCn.duplicate, true);
  assert.equal(dupCn.existing.id, 'sg-cn');
});

test('subgoal-tracker: allows concurrent reads, blocks write-write & read-write conflicts, releases on complete', () => {
  const tracker = createSubgoalTracker();

  // Two concurrent reads on the same path: allowed
  const r1 = tracker.registerSubgoal('locks', {
    id: 'read-1',
    description: 'Read chunk store implementation',
    access: 'read',
    paths: ['shared/chunk-store.mjs'],
  });
  const r2 = tracker.registerSubgoal('locks', {
    id: 'read-2',
    description: 'Search exports in chunk store',
    access: 'read',
    paths: ['shared/chunk-store.mjs'],
  });
  assert.equal(r1.conflict, false);
  assert.equal(r2.conflict, false);

  // Write while reads are in_flight on overlapping path -> conflict
  const wWhileRead = tracker.registerSubgoal('locks', {
    id: 'write-1',
    description: 'Edit chunk store',
    access: 'write',
    paths: ['shared/chunk-store.mjs'],
  });
  assert.equal(wWhileRead.conflict, true);
  assert.equal(wWhileRead.registered, false);
  assert.deepEqual(
    wWhileRead.holders.map((h) => h.id).sort(),
    ['read-1', 'read-2']
  );

  // Complete both readers -> write now succeeds
  tracker.completeSubgoal('locks', 'read-1', { status: 'completed' });
  tracker.completeSubgoal('locks', 'read-2', { status: 'completed' });

  const w1 = tracker.registerSubgoal('locks', {
    id: 'write-1',
    description: 'Edit chunk store',
    access: 'write',
    paths: ['shared/chunk-store.mjs'],
  });
  assert.equal(w1.conflict, false);
  assert.equal(w1.registered, true);

  // Write-Write conflict on same path (and parent directory overlap)
  const w2 = tracker.registerSubgoal('locks', {
    id: 'write-2',
    description: 'Refactor shared directory',
    access: 'write',
    paths: ['shared'],
  });
  assert.equal(w2.conflict, true);
  assert.equal(w2.holders.length, 1);
  assert.equal(w2.holders[0].id, 'write-1');

  // Read while write is in_flight on same path -> conflict
  const rWhileWrite = tracker.registerSubgoal('locks', {
    id: 'read-3',
    description: 'Inspect chunk store during write',
    access: 'read',
    paths: ['./shared\\chunk-store.mjs'],
  });
  assert.equal(rWhileWrite.conflict, true);
  assert.equal(rWhileWrite.holders[0].id, 'write-1');

  // Disjoint write path -> allowed concurrently
  const wDisjoint = tracker.registerSubgoal('locks', {
    id: 'write-other',
    description: 'Edit conditional rules',
    access: 'write',
    paths: ['shared/conditional-rules.mjs'],
  });
  assert.equal(wDisjoint.conflict, false);
  assert.equal(wDisjoint.registered, true);

  // Complete write-1 -> releases lock for write-2
  tracker.completeSubgoal('locks', 'write-1', { status: 'completed', summary: 'Edited chunk-store' });
  const w2Retry = tracker.registerSubgoal('locks', {
    id: 'write-2',
    description: 'Edit chunk store phase 2',
    access: 'write',
    paths: ['shared/chunk-store.mjs'],
  });
  assert.equal(w2Retry.conflict, false);
  assert.equal(w2Retry.registered, true);

  assert.equal(tracker.listSubgoals('locks').length, 5);
  tracker.clearSession('locks');
  assert.equal(tracker.listSubgoals('locks').length, 0);
});
