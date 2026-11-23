/**
 * test/search.test.js
 * Semantic search acceptance and kit-bundling tests (local TF-IDF mode).
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, search, getCompatibleBundle } from '../src/search/index.js';
import { getLabDistance, itemRepo } from '../src/repo/index.js';

before(() => {
  buildIndex();
});

describe('Semantic search – local TF-IDF mode', () => {
  test('"test a 5G millimeter-wave antenna" puts spectrum analyser or VNA in top 3', async () => {
    const { results } = await search({ q: 'test a 5G millimeter-wave antenna' });
    const top3Ids = results.slice(0, 3).map(r => r.item.id);
    const hasRfItem = top3Ids.some(id =>
      ['vna-keysight-p9374a', 'spectrum-rohde-fpc1500', 'spectrum-analyser-rohde'].includes(id)
    );
    assert.ok(hasRfItem, `Expected RF item in top 3, got: ${top3Ids.join(', ')}`);
  });

  test('"edge computer vision" puts Jetson Orin in top 3', async () => {
    const { results } = await search({ q: 'edge computer vision' });
    const top3Ids = results.slice(0, 3).map(r => r.item.id);
    assert.ok(top3Ids.includes('jetson-orin-agx'),
      `Expected jetson-orin-agx in top 3, got: ${top3Ids.join(', ')}`);
  });

  test('"SLAM navigation robot" returns LiDAR or Jetson in top 5', async () => {
    const { results } = await search({ q: 'SLAM navigation robot' });
    const top5Ids = results.slice(0, 5).map(r => r.item.id);
    const hasSlamItem = top5Ids.some(id => ['lidar-ouster-os1', 'jetson-orin-agx'].includes(id));
    assert.ok(hasSlamItem, `Expected SLAM item, got: ${top5Ids.join(', ')}`);
  });

  test('department filter narrows results', async () => {
    const { results } = await search({ q: 'oscilloscope', department: 'ECE' });
    for (const r of results) {
      assert.strictEqual(r.item.department, 'ECE');
    }
  });

  test('status filter works', async () => {
    const { results } = await search({ q: '', status: 'available' });
    for (const r of results) {
      assert.strictEqual(r.item.status, 'available');
    }
  });

  test('tier filter narrows results', async () => {
    const { results } = await search({ q: '', tier: '3' });
    for (const r of results) {
      assert.strictEqual(r.item.tier, 3);
    }
  });

  test('pagination works', async () => {
    const page1 = await search({ q: '', page: 1, pageSize: 3 });
    const page2 = await search({ q: '', page: 2, pageSize: 3 });
    assert.ok(page1.results.length <= 3);
    assert.ok(page2.results.length <= 3);
    if (page1.results.length > 0 && page2.results.length > 0) {
      assert.notStrictEqual(page1.results[0].item.id, page2.results[0].item.id);
    }
  });

  test('empty query returns all items', async () => {
    const { total } = await search({ q: '' });
    assert.ok(total > 0);
  });

  test('results have score, whyMatched, and statusBadge', async () => {
    const { results } = await search({ q: 'oscilloscope' });
    for (const r of results) {
      assert.ok(typeof r.score === 'number');
      assert.ok(typeof r.whyMatched === 'string');
      assert.ok(typeof r.statusBadge === 'object');
      assert.ok(r.statusBadge.text);
      assert.ok(r.statusBadge.icon);
    }
  });
});

describe('Smart Kit Bundling', () => {
  test('Jetson bundle includes camera', () => {
    const jetson = itemRepo.findById('jetson-orin-agx');
    assert.ok(jetson, 'Jetson not found');
    const bundle = getCompatibleBundle(jetson, getLabDistance);
    const cameraInBundle = bundle.some(b => b.item.id === 'camera-realsense-d435');
    assert.ok(cameraInBundle, 'Expected camera in Jetson bundle');
  });

  test('bundle sorted by lab distance (ascending)', () => {
    const jetson = itemRepo.findById('jetson-orin-agx');
    if (!jetson) { return; }
    const bundle = getCompatibleBundle(jetson, getLabDistance);
    for (let i = 1; i < bundle.length; i++) {
      assert.ok(bundle[i].distance >= bundle[i - 1].distance,
        'Bundle not sorted by distance');
    }
  });

  test('item with no compatibleWith returns empty bundle', () => {
    const workstation = itemRepo.findById('gpu-ws-rtx4090');
    if (!workstation) { return; }
    const bundle = getCompatibleBundle(workstation, getLabDistance);
    assert.strictEqual(bundle.length, 0);
  });
});
