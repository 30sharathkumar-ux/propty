/**
 * test/scheduler.test.js
 * Tests for the Conflict Mediator (pure functions).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  intervalsOverlap,
  findConflicts,
  computeScore,
  mediate,
  findNextFreeSlot,
  findEquivalentItem,
  WEIGHT_DEADLINE,
  WEIGHT_FAIRNESS,
  WEIGHT_SPECIFICITY,
  WEIGHT_FEASIBILITY,
} from '../src/scheduler/index.js';

// ── Weight sum assertion ──────────────────────────────────────────────────────
describe('Scheduler weights', () => {
  test('weights sum to exactly 1', () => {
    const sum = WEIGHT_DEADLINE + WEIGHT_FAIRNESS + WEIGHT_SPECIFICITY + WEIGHT_FEASIBILITY;
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `Weights sum to ${sum}, expected 1`);
  });
});

// ── Interval overlap detection ────────────────────────────────────────────────
describe('intervalsOverlap', () => {
  test('overlapping intervals', () => {
    assert.ok(intervalsOverlap(0, 10, 5, 15));
  });
  test('contained interval', () => {
    assert.ok(intervalsOverlap(0, 10, 2, 8));
  });
  test('non-overlapping', () => {
    assert.ok(!intervalsOverlap(0, 5, 10, 15));
  });
  test('back-to-back slots do NOT overlap', () => {
    assert.ok(!intervalsOverlap(0, 3600_000, 3600_000, 7200_000));
  });
  test('identical intervals overlap', () => {
    assert.ok(intervalsOverlap(100, 200, 100, 200));
  });
});

// ── findConflicts ─────────────────────────────────────────────────────────────
describe('findConflicts', () => {
  const makeBooking = (id, startH, endH) => {
    const base = new Date('2025-01-06T00:00:00Z'); // Monday
    const start = new Date(base); start.setHours(startH);
    const end   = new Date(base); end.setHours(endH);
    return { id, start: start.toISOString(), end: end.toISOString() };
  };

  test('no conflicts with one booking', () => {
    assert.deepStrictEqual(findConflicts([makeBooking('a', 8, 9)]), []);
  });

  test('detects overlapping bookings', () => {
    const conflicts = findConflicts([
      makeBooking('a', 8, 10),
      makeBooking('b', 9, 11),
    ]);
    assert.strictEqual(conflicts.length, 1);
    assert.ok(conflicts[0].includes('a') && conflicts[0].includes('b'));
  });

  test('back-to-back slots produce no conflict', () => {
    const conflicts = findConflicts([
      makeBooking('a', 8, 9),
      makeBooking('b', 9, 10),
    ]);
    assert.strictEqual(conflicts.length, 0);
  });

  test('three-way conflict', () => {
    const conflicts = findConflicts([
      makeBooking('a', 8, 11),
      makeBooking('b', 9, 12),
      makeBooking('c', 10, 13),
    ]);
    assert.ok(conflicts.length >= 2);
  });

  test('empty list produces no conflicts', () => {
    assert.deepStrictEqual(findConflicts([]), []);
  });
});

// ── computeScore ─────────────────────────────────────────────────────────────
describe('computeScore', () => {
  const ref = new Date('2025-01-06T10:00:00Z');

  const makeReq = (overrides = {}) => ({
    id: 'r1',
    userId: 'u1',
    projectId: 'p1',
    itemId: 'i1',
    start: '2025-01-06T10:00:00Z',
    end: '2025-01-06T11:00:00Z',
    requestedAt: '2025-01-06T08:00:00Z',
    projectDeadline: '2025-01-10T00:00:00Z', // 4 days
    projectHoursNeeded: 8,
    userTrailingHours: 0,
    itemTier: 2,
    neededTier: 2,
    firstTimeUser: false,
    ...overrides,
  });

  test('score is between 0 and 1', () => {
    const { total } = computeScore(makeReq(), ref);
    assert.ok(total >= 0 && total <= 1, `Score out of range: ${total}`);
  });

  test('first-time user gets fairness boost', () => {
    const { breakdown: f1 } = computeScore(makeReq({ firstTimeUser: true  }), ref);
    const { breakdown: f0 } = computeScore(makeReq({ firstTimeUser: false }), ref);
    assert.ok(f1.fairness >= f0.fairness);
  });

  test('heavy user gets lower fairness score', () => {
    const { breakdown: low  } = computeScore(makeReq({ userTrailingHours: 5  }), ref);
    const { breakdown: high } = computeScore(makeReq({ userTrailingHours: 50 }), ref);
    assert.ok(high.fairness < low.fairness);
  });

  test('closer deadline gives higher deadline score', () => {
    const soon = new Date(ref); soon.setDate(soon.getDate() + 1);
    const far  = new Date(ref); far.setDate(far.getDate() + 30);
    const { breakdown: s } = computeScore(makeReq({ projectDeadline: soon.toISOString() }), ref);
    const { breakdown: f } = computeScore(makeReq({ projectDeadline: far.toISOString() }), ref);
    assert.ok(s.deadline > f.deadline);
  });

  test('over-requesting high-tier item reduces specificity score', () => {
    const exact  = computeScore(makeReq({ itemTier: 2, neededTier: 2 }), ref);
    const over   = computeScore(makeReq({ itemTier: 3, neededTier: 1 }), ref);
    assert.ok(over.breakdown.specificity < exact.breakdown.specificity);
  });

  test('already-past deadline scores 1 for deadline', () => {
    const past = new Date(ref); past.setDate(past.getDate() - 1);
    const { breakdown } = computeScore(makeReq({ projectDeadline: past.toISOString() }), ref);
    assert.strictEqual(breakdown.deadline, 1); // exp(-0.05 * 0) == 1
  });
});

// ── mediate ───────────────────────────────────────────────────────────────────
describe('mediate', () => {
  const ref = new Date('2025-01-06T10:00:00Z');
  const getLabDistance = () => 0;
  const allItems = [{ id: 'item1', name: 'Scope', equivalentGroup: 'osc', tier: 2, lab: 'LAB_A', status: 'available' }];
  const allBookings = [];

  const makeReq = (id, overrides = {}) => ({
    id,
    userId: `user-${id}`,
    projectId: `proj-${id}`,
    itemId: 'item1',
    start: '2025-01-06T10:00:00Z',
    end: '2025-01-06T11:00:00Z',
    requestedAt: `2025-01-06T08:0${id}:00Z`,
    projectDeadline: '2025-01-10T00:00:00Z',
    projectHoursNeeded: 8,
    userTrailingHours: 0,
    itemTier: 2,
    neededTier: 2,
    firstTimeUser: false,
    ...overrides,
  });

  test('single request wins', () => {
    const result = mediate([makeReq('1')], allItems, allBookings, getLabDistance, ref);
    assert.strictEqual(result.winner, '1');
  });

  test('equal score tie-break: earlier request time wins', () => {
    const r1 = makeReq('1', { requestedAt: '2025-01-06T08:00:00Z' });
    const r2 = makeReq('2', { requestedAt: '2025-01-06T09:00:00Z' });
    const result = mediate([r1, r2], allItems, allBookings, getLabDistance, ref);
    assert.strictEqual(result.winner, '1'); // r1 requested earlier
  });

  test('urgent deadline wins over comfortable one', () => {
    const urgent     = makeReq('urgent', { projectDeadline: '2025-01-07T00:00:00Z', requestedAt: '2025-01-06T08:00:00Z' });
    const comfortable= makeReq('comfort', { projectDeadline: '2025-01-30T00:00:00Z', requestedAt: '2025-01-06T07:00:00Z' });
    const result = mediate([urgent, comfortable], allItems, allBookings, getLabDistance, ref);
    assert.strictEqual(result.winner, 'urgent');
  });

  test('first-time user gets fairness boost over heavy user', () => {
    const firstTime  = makeReq('new', { firstTimeUser: true,  userTrailingHours: 0,  requestedAt: '2025-01-06T09:00:00Z' });
    const heavyUser  = makeReq('heavy', { firstTimeUser: false, userTrailingHours: 50, requestedAt: '2025-01-06T07:00:00Z' });
    const result = mediate([firstTime, heavyUser], allItems, allBookings, getLabDistance, ref);
    assert.strictEqual(result.winner, 'new');
  });

  test('score breakdown present for all requests', () => {
    const r1 = makeReq('1');
    const r2 = makeReq('2');
    const result = mediate([r1, r2], allItems, allBookings, getLabDistance, ref);
    assert.ok(result.scores['1']);
    assert.ok(result.scores['2']);
  });

  test('alternatives do not include options past deadline', () => {
    const past = new Date(ref); past.setDate(past.getDate() - 1);
    const loser = makeReq('loser', { projectDeadline: past.toISOString(), requestedAt: '2025-01-06T09:00:00Z' });
    const winner = makeReq('winner', { projectDeadline: '2025-01-20T00:00:00Z', requestedAt: '2025-01-06T07:00:00Z' });
    const result = mediate([winner, loser], allItems, allBookings, getLabDistance, ref);
    // Loser's deadline is past, so no alternatives for them
    const loserAlts = result.alternatives.filter(a => a.bookingId === 'loser');
    assert.strictEqual(loserAlts.length, 0);
  });

  test('swap proposal generated when loser deadline much sooner', () => {
    // Winner: comfortable deadline, first-time user (high fairness), early request
    // Loser: very urgent deadline (< 3 days), heavy user, later request
    const winner = makeReq('winner', {
      projectDeadline: '2025-01-20T00:00:00Z',
      requestedAt: '2025-01-06T07:00:00Z',
      firstTimeUser: true,
      userTrailingHours: 0,
    });
    const loser = makeReq('loser', {
      projectDeadline: '2025-01-07T12:00:00Z', // only 1.5 days away
      requestedAt: '2025-01-06T09:00:00Z',
      firstTimeUser: false,
      userTrailingHours: 50, // heavy user, lower fairness
    });
    const result = mediate([winner, loser], allItems, allBookings, getLabDistance, ref);
    assert.strictEqual(result.winner, 'winner');
    assert.ok(result.swapProposals.length > 0, 'Expected swap proposal for urgently-deadlined loser');
  });

  test('mediate throws on empty request list', () => {
    assert.throws(() => mediate([], allItems, allBookings, getLabDistance, ref));
  });
});

// ── findEquivalentItem ────────────────────────────────────────────────────────
describe('findEquivalentItem', () => {
  const item = { id: 'osc1', name: 'Scope A', equivalentGroup: 'osc', tier: 2, lab: 'LAB_A', status: 'available' };
  const equiv = { id: 'osc2', name: 'Scope B', equivalentGroup: 'osc', tier: 2, lab: 'LAB_B', status: 'available' };
  const noEquiv = { id: 'other', name: 'VNA', equivalentGroup: 'vna', tier: 2, lab: 'LAB_A', status: 'available' };

  test('finds equivalent item', () => {
    const result = findEquivalentItem(item, '2025-01-06T10:00:00Z', '2025-01-06T11:00:00Z',
      [item, equiv, noEquiv], [], () => 1);
    assert.ok(result !== null);
    assert.strictEqual(result.item.id, 'osc2');
  });

  test('returns null when no equivalent group', () => {
    const noGroup = { ...item, equivalentGroup: null };
    const result = findEquivalentItem(noGroup, '2025-01-06T10:00:00Z', '2025-01-06T11:00:00Z',
      [noGroup, equiv], [], () => 0);
    assert.strictEqual(result, null);
  });

  test('returns null when equivalent item is busy', () => {
    const result = findEquivalentItem(item, '2025-01-06T10:00:00Z', '2025-01-06T11:00:00Z',
      [item, equiv], [{ itemId: 'osc2', start: '2025-01-06T10:00:00Z', end: '2025-01-06T11:00:00Z', status: 'approved' }],
      () => 1);
    assert.strictEqual(result, null);
  });
});
