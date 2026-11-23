/**
 * src/scheduler/index.js
 * Conflict Mediator – pure functions; zero side-effects.
 * Weights are named constants from config.js (sum = 1, asserted in tests).
 */

import {
  WEIGHT_DEADLINE,
  WEIGHT_FAIRNESS,
  WEIGHT_SPECIFICITY,
  WEIGHT_FEASIBILITY,
  SLOT_DAY_START,
  SLOT_DAY_END,
  SLOT_HOURS,
  now,
} from '../config.js';

export { WEIGHT_DEADLINE, WEIGHT_FAIRNESS, WEIGHT_SPECIFICITY, WEIGHT_FEASIBILITY };

// ── Interval overlap detection (O(n log n)) ───────────────────────────────────

/**
 * Check whether two intervals [aStart, aEnd) and [bStart, bEnd) overlap.
 * Back-to-back slots (aEnd === bStart) do NOT overlap.
 * @param {number} aStart @param {number} aEnd
 * @param {number} bStart @param {number} bEnd
 * @returns {boolean}
 */
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Find conflicts among a list of bookings for the same item.
 * Returns pairs [i, j] of overlapping booking indices.
 * O(n log n) via sort + sweep.
 * @param {Array<{start: string, end: string, id: string}>} bookings
 * @returns {Array<[string, string]>} pairs of conflicting booking ids
 */
export function findConflicts(bookings) {
  if (bookings.length < 2) { return []; }

  // Sort by start time
  const sorted = [...bookings].sort((a, b) =>
    new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  const conflicts = [];
  for (let i = 0; i < sorted.length; i++) {
    const aEnd = new Date(sorted[i].end).getTime();
    for (let j = i + 1; j < sorted.length; j++) {
      const bStart = new Date(sorted[j].start).getTime();
      if (bStart >= aEnd) { break; } // sorted: no further j can overlap i
      conflicts.push([sorted[i].id, sorted[j].id]);
    }
  }
  return conflicts;
}

// ── Priority score ────────────────────────────────────────────────────────────

/**
 * @typedef {object} ScoredRequest
 * @property {string} id
 * @property {string} userId
 * @property {string} projectId
 * @property {string} itemId
 * @property {string} start
 * @property {string} end
 * @property {string} requestedAt
 * @property {string} projectDeadline      ISO date
 * @property {number} projectHoursNeeded
 * @property {number} userTrailingHours   trailing 14-day usage hours
 * @property {number} itemTier            1-3
 * @property {number} neededTier          min tier actually needed by project (1-3)
 * @property {boolean} firstTimeUser
 */

/**
 * Compute priority score for a request.
 * All sub-scores are in [0, 1]; higher = higher priority.
 * @param {ScoredRequest} req
 * @param {Date} referenceDate  the logical "now" for deadline calculation
 * @returns {{ total: number, breakdown: Record<string, number> }}
 */
export function computeScore(req, referenceDate) {
  const refMs = referenceDate.getTime();
  const deadlineMs = new Date(req.projectDeadline).getTime();
  const daysUntil = Math.max(0, (deadlineMs - refMs) / 86_400_000);

  // Deadline proximity: 0 = >60 days, 1 = 0 days. Smooth exponential decay.
  const deadlineScore = daysUntil === 0 ? 1 : Math.exp(-0.05 * daysUntil);

  // Fairness: penalise heavy users, boost first-time users.
  // trailingHours=0 → 1.0, every 10 hours → -0.1, floor at 0.
  const fairnessScore = req.firstTimeUser
    ? 1.0
    : Math.max(0, 1 - req.userTrailingHours * 0.04);

  // Specificity: does the request genuinely need this tier?
  // If neededTier < itemTier, penalise (over-requesting high-tier resource).
  const tierGap = req.itemTier - req.neededTier;
  const specificityScore = Math.max(0, 1 - tierGap * 0.3);

  // Feasibility: ratio of hours needed vs available before deadline.
  const hoursUntilDeadline = Math.max(0, daysUntil) * (SLOT_DAY_END - SLOT_DAY_START);
  const feasibilityScore = hoursUntilDeadline === 0
    ? (req.projectHoursNeeded <= 0 ? 1 : 0)
    : Math.min(1, (hoursUntilDeadline / Math.max(1, req.projectHoursNeeded)));

  const total =
    WEIGHT_DEADLINE    * deadlineScore +
    WEIGHT_FAIRNESS    * fairnessScore +
    WEIGHT_SPECIFICITY * specificityScore +
    WEIGHT_FEASIBILITY * feasibilityScore;

  return {
    total: Math.min(1, Math.max(0, total)),
    breakdown: {
      deadline:    +deadlineScore.toFixed(4),
      fairness:    +fairnessScore.toFixed(4),
      specificity: +specificityScore.toFixed(4),
      feasibility: +feasibilityScore.toFixed(4),
    },
  };
}

// ── Alternative generation ────────────────────────────────────────────────────

/**
 * @typedef {object} ConflictAlternative
 * @property {'next_slot'|'equivalent_item'|'split_slot'|'swap_proposal'} type
 * @property {string} description
 * @property {object} [data]
 */

/**
 * Generate valid weekday slot hours for a given date.
 * @param {Date} date
 * @returns {number[]} array of valid start hours (08-19)
 */
function weekdaySlotHours() {
  const hours = [];
  for (let h = SLOT_DAY_START; h < SLOT_DAY_END; h += SLOT_HOURS) {
    hours.push(h);
  }
  return hours;
}

/**
 * Find next free slot for an item before or on deadline.
 * @param {string} itemId
 * @param {Date} afterDate  start searching from this date
 * @param {Date} deadline
 * @param {Array<{start: string, end: string, status: string}>} existingBookings
 * @returns {{ start: Date, end: Date }|null}
 */
export function findNextFreeSlot(itemId, afterDate, deadline, existingBookings) {
  void itemId; // used by caller for context
  const slotHours = weekdaySlotHours();
  const deadlineMs = deadline.getTime();

  const current = new Date(afterDate);
  // Start from next hour boundary
  current.setMinutes(0, 0, 0);
  current.setHours(current.getHours() + 1);

  for (let attempt = 0; attempt < 60; attempt++) { // max 60 days search
    // Skip weekends
    if (current.getDay() === 0) { current.setDate(current.getDate() + 1); continue; }
    if (current.getDay() === 6) { current.setDate(current.getDate() + 2); continue; }

    for (const h of slotHours) {
      const slotStart = new Date(current);
      slotStart.setHours(h, 0, 0, 0);
      const slotEnd = new Date(slotStart);
      slotEnd.setHours(h + SLOT_HOURS);

      if (slotStart.getTime() <= afterDate.getTime()) { continue; }
      if (slotStart.getTime() > deadlineMs) { return null; }

      const overlapping = existingBookings.some(b => {
        if (!['approved', 'pending', 'checked_in'].includes(b.status)) { return false; }
        return intervalsOverlap(
          slotStart.getTime(), slotEnd.getTime(),
          new Date(b.start).getTime(), new Date(b.end).getTime()
        );
      });

      if (!overlapping) {
        return { start: slotStart, end: slotEnd };
      }
    }
    current.setDate(current.getDate() + 1);
  }
  return null;
}

/**
 * Find an equivalent item (same equivalentGroup, acceptable tier) that is free.
 * @param {object} item  the contested item
 * @param {string} start ISO start
 * @param {string} end ISO end
 * @param {object[]} allItems
 * @param {object[]} allBookings
 * @param {Function} getLabDistance  (labA: string, labB: string) => number
 * @param {number} [maxTierStep=1]  how many tier levels down is acceptable
 * @returns {{ item: object, distance: number }|null}
 */
export function findEquivalentItem(item, start, end, allItems, allBookings, getLabDistance, maxTierStep = 1) {
  if (!item.equivalentGroup) { return null; }

  const startMs = new Date(start).getTime();
  const endMs   = new Date(end).getTime();

  const candidates = allItems.filter(alt =>
    alt.id !== item.id &&
    alt.equivalentGroup === item.equivalentGroup &&
    alt.tier >= item.tier - maxTierStep &&
    alt.status !== 'maintenance'
  );

  const withDistance = candidates.map(alt => {
    const busy = allBookings.some(b => {
      if (b.itemId !== alt.id) { return false; }
      if (!['approved', 'pending', 'checked_in'].includes(b.status)) { return false; }
      return intervalsOverlap(startMs, endMs, new Date(b.start).getTime(), new Date(b.end).getTime());
    });
    return { item: alt, distance: getLabDistance(item.lab, alt.lab), busy };
  }).filter(c => !c.busy);

  if (!withDistance.length) { return null; }
  withDistance.sort((a, b) => a.distance - b.distance || a.item.tier - b.item.tier);
  return withDistance[0];
}

// ── Main mediation ────────────────────────────────────────────────────────────

/**
 * @typedef {object} MediationResult
 * @property {string} winner  booking id
 * @property {Record<string, { total: number, breakdown: object }>} scores
 * @property {ConflictAlternative[]} alternatives
 * @property {object[]} swapProposals
 * @property {string} reason  human-readable reason (English template)
 */

/**
 * Mediate a set of competing requests for the same item + time slot.
 * Pure function – deterministic, no I/O.
 *
 * @param {ScoredRequest[]} requests    competing requests (all overlap)
 * @param {object[]} allItems           full item catalogue (for equivalents)
 * @param {object[]} allBookings        all existing bookings (for free-slot search)
 * @param {Function} getLabDistance     (labA, labB) => number
 * @param {Date} [referenceDate]        injectable clock (defaults to now())
 * @returns {MediationResult}
 */
export function mediate(requests, allItems, allBookings, getLabDistance, referenceDate) {
  if (!requests || requests.length === 0) {
    throw new Error('mediate: at least one request required');
  }

  const ref = referenceDate ?? now();

  // Score each request
  const scored = requests.map(req => ({
    req,
    ...computeScore(req, ref),
  }));

  // Sort: descending total score; tie-break by requestedAt (earlier = higher priority), then id
  scored.sort((a, b) => {
    if (Math.abs(a.total - b.total) > 1e-9) { return b.total - a.total; }
    const tA = new Date(a.req.requestedAt).getTime();
    const tB = new Date(b.req.requestedAt).getTime();
    if (tA !== tB) { return tA - tB; }
    return a.req.id < b.req.id ? -1 : 1;
  });

  const winner = scored[0];
  const losers = scored.slice(1);

  const item = allItems.find(it => it.id === winner.req.itemId);
  const itemBookings = allBookings.filter(b => b.itemId === winner.req.itemId && b.id !== winner.req.id);

  const alternatives = [];
  const swapProposals = [];

  for (const loser of losers) {
    const loserDeadline = new Date(loser.req.projectDeadline);
    if (loserDeadline <= ref) { continue; } // already past deadline

    // (a) Next free slot before deadline
    const nextSlot = findNextFreeSlot(
      loser.req.itemId,
      new Date(loser.req.start),
      loserDeadline,
      itemBookings
    );
    if (nextSlot) {
      alternatives.push({
        bookingId: loser.req.id,
        type: 'next_slot',
        description: `Next free slot: ${nextSlot.start.toISOString()} – ${nextSlot.end.toISOString()}`,
        data: { start: nextSlot.start.toISOString(), end: nextSlot.end.toISOString() },
      });
    }

    // (b) Equivalent item
    if (item) {
      const equiv = findEquivalentItem(
        item, loser.req.start, loser.req.end,
        allItems, allBookings, getLabDistance
      );
      if (equiv) {
        alternatives.push({
          bookingId: loser.req.id,
          type: 'equivalent_item',
          description: `Equivalent: ${equiv.item.name} (${equiv.item.lab}, ${equiv.distance === 0 ? 'same lab' : `distance ${equiv.distance}`})`,
          data: { itemId: equiv.item.id, itemName: equiv.item.name, lab: equiv.item.lab, distance: equiv.distance },
        });
      }
    }

    // (c) Split across two shorter slots
    const halfHours = Math.max(1, Math.round((new Date(loser.req.end).getTime() - new Date(loser.req.start).getTime()) / 3_600_000 / 2));
    if (halfHours >= 1 && nextSlot) {
      const splitEnd = new Date(nextSlot.start);
      splitEnd.setHours(splitEnd.getHours() + halfHours);
      alternatives.push({
        bookingId: loser.req.id,
        type: 'split_slot',
        description: `Split: ${halfHours}h in next free slot`,
        data: { start: nextSlot.start.toISOString(), end: splitEnd.toISOString(), originalHours: halfHours * 2 },
      });
    }

    // (d) Swap proposal: if loser's deadline is much sooner than winner's
    const winnerDeadline = new Date(winner.req.projectDeadline);
    const loserDaysLeft  = (loserDeadline.getTime() - ref.getTime()) / 86_400_000;
    const winnerDaysLeft = (winnerDeadline.getTime() - ref.getTime()) / 86_400_000;
    if (loserDaysLeft < winnerDaysLeft - 2) {
      swapProposals.push({
        proposedBy: loser.req.id,
        proposedTo:  winner.req.id,
        reason: `Loser deadline is ${(winnerDaysLeft - loserDaysLeft).toFixed(1)} days sooner than winner.`,
        status: 'pending',
      });
    }
  }

  // Build scores map
  const scores = {};
  for (const s of scored) {
    scores[s.req.id] = { total: +s.total.toFixed(4), breakdown: s.breakdown };
  }

  const reason = buildReason(winner, losers, item);

  return {
    winner: winner.req.id,
    scores,
    alternatives,
    swapProposals,
    reason,
  };
}

/**
 * Build a template reason string.
 * @param {object} winner
 * @param {object[]} losers
 * @param {object|undefined} item
 * @returns {string}
 */
function buildReason(winner, losers, item) {
  const itemName = item?.name ?? 'requested item';
  const loserNames = losers.map(l => l.req.userId).join(', ');
  return `Request ${winner.req.id} has the highest priority score (${winner.total.toFixed(3)}) ` +
    `for "${itemName}" based on deadline proximity (${winner.breakdown.deadline.toFixed(2)}), ` +
    `fairness (${winner.breakdown.fairness.toFixed(2)}), ` +
    `specificity (${winner.breakdown.specificity.toFixed(2)}), ` +
    `and feasibility (${winner.breakdown.feasibility.toFixed(2)}). ` +
    (losers.length ? `${losers.length} competing request(s) [${loserNames}] have been offered alternatives.` : '');
}
