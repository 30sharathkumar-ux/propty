/**
 * src/routes/scheduler.js
 * Conflict demo endpoint and scheduler API.
 */

import { Router } from 'express';
import { mediate } from '../scheduler/index.js';
import { bookingRepo, itemRepo, userRepo } from '../repo/index.js';
import { getLabDistance } from '../repo/index.js';
import { validateConflictDemo } from '../validation/index.js';
import { requireAuth, requireRole } from '../middleware/index.js';
import { geminiService } from '../services/gemini.js';
import { now } from '../config.js';

const router = Router();

/**
 * POST /api/scheduler/demo
 * Creates 3 competing requests for a chosen item and runs mediation.
 * Shows the resolution in under 60 seconds.
 */
router.post('/demo', requireRole('admin', 'faculty', 'student'), async (req, res, next) => {
  try {
    const validation = validateConflictDemo(req.body);
    if (validation.error) { return res.status(400).json({ error: validation.error }); }

    const { itemId } = validation.value;
    const item = itemRepo.findById(itemId);
    if (!item) { return res.status(404).json({ error: 'Item not found' }); }

    // Build 3 synthetic competing requests with different deadline urgencies
    const refNow = now();
    const slotStart = new Date(refNow);
    slotStart.setHours(10, 0, 0, 0);
    // next weekday
    if (slotStart.getDay() === 0) { slotStart.setDate(slotStart.getDate() + 1); }
    if (slotStart.getDay() === 6) { slotStart.setDate(slotStart.getDate() + 2); }
    if (slotStart <= refNow) { slotStart.setDate(slotStart.getDate() + 1); }
    const slotEnd = new Date(slotStart);
    slotEnd.setHours(11, 0, 0, 0);

    const demoUsers = [
      { id: 'u-stu-alice', trailingHours: 8,  deadlineDays: 5,  firstTime: false },
      { id: 'u-stu-bob',   trailingHours: 22, deadlineDays: 10, firstTime: false },
      { id: 'u-stu-dave',  trailingHours: 0,  deadlineDays: 3,  firstTime: true  },
    ];

    const requests = demoUsers.map((u, idx) => {
      const deadline = new Date(refNow);
      deadline.setDate(deadline.getDate() + u.deadlineDays);
      return {
        id: `demo-req-${idx + 1}`,
        userId: u.id,
        projectId: `demo-proj-${idx + 1}`,
        itemId,
        start: slotStart.toISOString(),
        end: slotEnd.toISOString(),
        requestedAt: new Date(refNow.getTime() - (3 - idx) * 3600_000).toISOString(),
        projectDeadline: deadline.toISOString(),
        projectHoursNeeded: 8,
        userTrailingHours: u.trailingHours,
        itemTier: item.tier,
        neededTier: item.tier,
        firstTimeUser: u.firstTime,
      };
    });

    const allItems = itemRepo.findAll();
    const allBookings = bookingRepo.findAll();
    const result = mediate(requests, allItems, allBookings, getLabDistance, refNow);

    // Get friendly negotiation text
    const { text: negotiationText, source } = await geminiService.negotiationText(result, item);

    // Add winner user info
    const winnerReq = requests.find(r => r.id === result.winner);
    const winnerUser = winnerReq ? userRepo.findById(winnerReq.userId) : null;

    return res.json({
      demo: true,
      item: { id: item.id, name: item.name, lab: item.lab },
      slotStart: slotStart.toISOString(),
      slotEnd: slotEnd.toISOString(),
      requests: requests.map(r => ({ ...r, userName: userRepo.findById(r.userId)?.name })),
      result,
      negotiationText,
      negotiationSource: source,
      winnerUser: winnerUser ? { id: winnerUser.id, name: winnerUser.name } : null,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/scheduler/slots/:itemId
 * Returns available slots for an item (calendar grid data).
 */
router.get('/slots/:itemId', requireAuth, (req, res) => {
  const item = itemRepo.findById(req.params.itemId);
  if (!item) { return res.status(404).json({ error: 'Item not found' }); }

  const { days = '14' } = req.query;
  const numDays = Math.min(60, Math.max(1, parseInt(days, 10)));

  const refNow = now();
  const slots = [];

  for (let d = 0; d < numDays; d++) {
    const day = new Date(refNow);
    day.setDate(day.getDate() + d);
    day.setHours(0, 0, 0, 0);
    if (day.getDay() === 0 || day.getDay() === 6) { continue; } // skip weekends

    for (let h = 8; h < 20; h++) {
      const start = new Date(day);
      start.setHours(h);
      const end = new Date(day);
      end.setHours(h + 1);

      if (start <= refNow) { continue; }

      const overlapping = bookingRepo.findOverlapping(item.id, start.toISOString(), end.toISOString());
      slots.push({
        start: start.toISOString(),
        end: end.toISOString(),
        available: overlapping.length === 0,
        bookingCount: overlapping.length,
      });
    }
  }

  return res.json({ itemId: item.id, slots });
});

export default router;
