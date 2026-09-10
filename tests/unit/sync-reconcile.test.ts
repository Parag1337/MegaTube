import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { planReconciliation } from '@/lib/sync/reconcile';
import type { RemoteVideoNode, ExistingVideoRow } from '@/lib/sync/reconcile';

const KEY = crypto.randomBytes(32);

function remote(overrides: Partial<RemoteVideoNode> = {}): RemoteVideoNode {
  return {
    nodeId: 'n1',
    parentNodeId: null,
    name: 'clip.mp4',
    size: 1000,
    ts: 1_700_000_000,
    fa: '1:0*t1',
    fileKey: KEY,
    ...overrides,
  };
}

function existing(nodeId = 'n1', overrides: Partial<ExistingVideoRow> = {}): ExistingVideoRow {
  return {
    id: 1,
    megaNodeId: nodeId,
    megaFilename: 'clip.mp4',
    fileSize: BigInt(1000),
    parentNodeId: null,
    megaModifiedAt: new Date(1_700_000_000 * 1000),
    megaFa: '1:0*t1',
    thumbnailAvailable: false,
    thumbnail: null,
    ...overrides,
  };
}

test('new file -> add', () => {
  const plan = planReconciliation([remote()], []);
  assert.equal(plan.toAdd.length, 1);
  assert.equal(plan.toUpdate.length, 0);
  assert.equal(plan.toRemove.length, 0);
  assert.equal(plan.unchanged.length, 0);
});

test('unchanged file -> no writes, no duplicate', () => {
  const plan = planReconciliation([remote()], [existing()]);
  assert.equal(plan.unchanged.length, 1);
  assert.equal(plan.toAdd.length, 0);
  assert.equal(plan.toUpdate.length, 0);
  assert.equal(plan.toRemove.length, 0);
});

test('repeated sync is idempotent', () => {
  const first = planReconciliation([remote()], [existing()]);
  const second = planReconciliation([remote()], [existing()]);
  assert.deepEqual(
    { a: first.toAdd.length, u: first.toUpdate.length, r: first.toRemove.length, n: first.unchanged.length },
    { a: 0, u: 0, r: 0, n: 1 },
  );
  assert.deepEqual(
    { a: second.toAdd.length, u: second.toUpdate.length, r: second.toRemove.length, n: second.unchanged.length },
    { a: 0, u: 0, r: 0, n: 1 },
  );
});

test('renamed file -> update with rename', () => {
  const plan = planReconciliation([remote({ name: 'new-name.mp4' })], [existing()]);
  assert.equal(plan.toUpdate.length, 1);
  assert.ok(plan.toUpdate[0].changes.includes('rename'));
});

test('moved file -> update with move', () => {
  const plan = planReconciliation(
    [remote({ parentNodeId: 'parentX' })],
    [existing('n1', { parentNodeId: 'parentY' })],
  );
  assert.equal(plan.toUpdate.length, 1);
  assert.ok(plan.toUpdate[0].changes.includes('move'));
});

test('deleted file -> remove', () => {
  const plan = planReconciliation([], [existing()]);
  assert.equal(plan.toRemove.length, 1);
  assert.equal(plan.toAdd.length, 0);
  assert.equal(plan.toUpdate.length, 0);
});

test('re-upload (new node handle) -> remove old + add new, no duplicate', () => {
  const plan = planReconciliation([remote({ nodeId: 'n2' })], [existing('n1')]);
  assert.equal(plan.toRemove.length, 1);
  assert.equal(plan.toAdd.length, 1);
  assert.equal(plan.toUpdate.length, 0);
  assert.equal(plan.toRemove[0].megaNodeId, 'n1');
  assert.equal(plan.toAdd[0].nodeId, 'n2');
});

test('size change -> update with size', () => {
  const plan = planReconciliation([remote({ size: 2000 })], [existing()]);
  assert.equal(plan.toUpdate.length, 1);
  assert.ok(plan.toUpdate[0].changes.includes('size'));
});

test('timestamp change -> update with timestamp', () => {
  const plan = planReconciliation(
    [remote({ ts: 1_700_000_999 })],
    [existing()],
  );
  assert.equal(plan.toUpdate.length, 1);
  assert.ok(plan.toUpdate[0].changes.includes('timestamp'));
});

test('file-attributes change -> update with file-attributes', () => {
  const plan = planReconciliation([remote({ fa: '1:0*t1/1:8*m1' })], [existing()]);
  assert.equal(plan.toUpdate.length, 1);
  assert.ok(plan.toUpdate[0].changes.includes('file-attributes'));
});

test('null stored fileSize counts as a change', () => {
  const plan = planReconciliation([remote({ size: 1000 })], [existing('n1', { fileSize: null })]);
  assert.equal(plan.toUpdate.length, 1);
  assert.ok(plan.toUpdate[0].changes.includes('size'));
});

test('multiple files: every node handle appears exactly once in the plan', () => {
  const remotes = [remote({ nodeId: 'a' }), remote({ nodeId: 'b' }), remote({ nodeId: 'c' })];
  const rows = [existing('a', { id: 1 }), existing('b', { id: 2 })];
  const plan = planReconciliation(remotes, rows);

  const handles = [
    ...plan.toAdd.map((r) => r.nodeId),
    ...plan.toUpdate.map((u) => u.remote.nodeId),
    ...plan.toRemove.map((r) => r.megaNodeId),
    ...plan.unchanged.map((r) => r.megaNodeId),
  ];
  assert.equal(handles.length, 3);
  assert.equal(new Set(handles).size, 3, 'no duplicate handle in plan');
});
