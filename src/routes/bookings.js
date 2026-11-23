/**
 * src/routes/bookings.js
 * Booking lifecycle: request, approval, check-in, waitlist swap.
 */

import { Router } from 'express';
import { bookingRepo, projectRepo, itemRepo, userRepo, notificationRepo } from '../repo/index.js';
import { validateBookingRequest, validateApprovalAction, validateCheckin, validateWaitlistAction } from '../validation/index.js';
import { requireAuth, requireRole } from '../middleware/index.js';
import { mediate } from '../scheduler/index.js';
import { getLabDistance } from '../repo/index.js';
import { geminiService } from '../services/gemini.js';
import { generateCheckinToken, verifyCheckinToken } from '../services/checkin.js';
import { sweepNoShows } from '../services/noshow.js';
import { now } from '../config.js';
import QRCode from 'qrcode';

const router = Router();

// ── Booking lifecycle transition table ───────────────────────────────────────
const VALID_TRANSITIONS = {
  pending:            ['approved', 'rejected', 'changes_requested', 'waitlisted'],
  waitlisted:         ['approved', 'rejected'],
  approved:           ['checked_in', 'released_no_show', 'completed'],
  changes_requested:  ['pending', 'rejected'],
  checked_in:         ['completed'],
  rejected:           [],
  released_no_show:   [],
  completed:          [],
  reallocated:        [],
};

/**
 * @param {string} from @param {string} to @returns {boolean}
 */
function isLegalTransition(from, to) {
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}

/** POST /api/bookings/swapreply – must be before /:id routes */
router.post('/swapreply', requireRole('student', 'admin'), (req, res) => {
  const validation = validateWaitlistAction(req.body);
  if (validation.error) { return res.status(400).json({ error: validation.error }); }

  const { bookingId, action } = validation.value;
  const booking = bookingRepo.findById(bookingId);
  if (!booking) { return res.status(404).json({ error: 'Booking not found' }); }
  if (booking.userId !== req.user.userId && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (action === 'accept') {
    bookingRepo.update(bookingId, { status: 'reallocated' });
    notificationRepo.add(booking.userId, 'info', 'Swap accepted. Your booking has been reallocated.', { bookingId });
  }

  return res.json({ ok: true, action });
});

/** POST /api/bookings/checkin – QR check-in (technician) */
router.post('/checkin', requireRole('technician', 'admin'), (req, res) => {
  sweepNoShows();
  const validation = validateCheckin(req.body);
  if (validation.error) { return res.status(400).json({ error: validation.error }); }

  const { token } = validation.value;

  // Find booking by checkinToken field
  const all = bookingRepo.findAll();
  const booking = all.find(b => b.checkinToken === token);
  if (!booking) { return res.status(404).json({ error: 'Token not found' }); }
  if (booking.status !== 'approved') { return res.status(409).json({ error: 'Booking is not in approved state' }); }

  const result = verifyCheckinToken(token, booking);
  if (!result.valid) { return res.status(400).json({ error: result.reason }); }

  bookingRepo.update(booking.id, { checkedIn: true, checkedInAt: now().toISOString(), status: 'checked_in' });
  notificationRepo.add(booking.userId, 'success', `Checked in for ${booking.itemId}. Enjoy your session!`, { bookingId: booking.id });
  return res.json({ ok: true, bookingId: booking.id });
});

/** GET /api/bookings – list bookings */
router.get('/', requireAuth, (req, res) => {
  sweepNoShows();
  const { role, userId } = req.user;
  let bookings;
  if (role === 'admin') {
    bookings = bookingRepo.findAll();
  } else if (role === 'faculty') {
    const facultyUser = userRepo.findById(userId);
    bookings = bookingRepo.findPending(facultyUser?.department ?? null);
  } else if (role === 'technician') {
    bookings = bookingRepo.findActive();
  } else {
    bookings = bookingRepo.findByUser(userId);
  }
  res.json({ bookings });
});

/** GET /api/bookings/:id */
router.get('/:id', requireAuth, (req, res) => {
  sweepNoShows();
  const booking = bookingRepo.findById(req.params.id);
  if (!booking) { return res.status(404).json({ error: 'Booking not found' }); }
  const { role, userId } = req.user;
  if (role === 'student' && booking.userId !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return res.json({ booking });
});

/** POST /api/bookings – request a booking */
router.post('/', requireRole('student', 'admin'), async (req, res, next) => {
  try {
    const validation = validateBookingRequest(req.body);
    if (validation.error) { return res.status(400).json({ error: validation.error }); }

    const { projectId, itemId, start, end } = validation.value;

    const project = projectRepo.findById(projectId);
    if (!project) { return res.status(404).json({ error: 'Project not found' }); }
    if (req.user.role === 'student' &&
        !project.teamMembers.includes(req.user.userId) &&
        project.createdBy !== req.user.userId) {
      return res.status(403).json({ error: 'You are not a member of this project' });
    }

    const item = itemRepo.findById(itemId);
    if (!item) { return res.status(404).json({ error: 'Item not found' }); }

    // Validate slot: weekday, 08:00–20:00, exactly 1 hour
    const startD = new Date(start);
    const endD   = new Date(end);
    if (startD.getDay() === 0 || startD.getDay() === 6) {
      return res.status(400).json({ error: 'Slots are only available on weekdays' });
    }
    if (startD.getHours() < 8 || endD.getHours() > 20) {
      return res.status(400).json({ error: 'Slots must be between 08:00 and 20:00' });
    }
    const durationMs = endD.getTime() - startD.getTime();
    if (durationMs !== 3_600_000) {
      return res.status(400).json({ error: 'Each slot must be exactly 1 hour' });
    }

    const deadline = new Date(project.hardDeadline);
    if (startD > deadline) {
      return res.status(400).json({ error: 'Slot is after the project deadline' });
    }

    // Check for conflicts and run mediator
    const overlapping = bookingRepo.findOverlapping(itemId, start, end);
    let status = item.requiresApproval ? 'pending' : 'approved';
    let mediationResult = null;

    if (overlapping.length > 0) {
      const user = userRepo.findById(req.user.userId);
      const myRequest = {
        id: 'new',
        userId: req.user.userId,
        projectId,
        itemId,
        start,
        end,
        requestedAt: now().toISOString(),
        projectDeadline: project.hardDeadline,
        projectHoursNeeded: project.hoursNeeded,
        userTrailingHours: userRepo.getTrailingHours(req.user.userId),
        itemTier: item.tier,
        neededTier: item.tier,
        firstTimeUser: (user?.trailingUsageHours ?? 0) === 0,
      };

      const competingRequests = overlapping.map(b => {
        const compUser    = userRepo.findById(b.userId);
        const compProject = projectRepo.findById(b.projectId);
        return {
          id: b.id,
          userId: b.userId,
          projectId: b.projectId,
          itemId: b.itemId,
          start: b.start,
          end: b.end,
          requestedAt: b.requestedAt,
          projectDeadline: compProject?.hardDeadline ?? new Date(Date.now() + 86_400_000 * 30).toISOString(),
          projectHoursNeeded: compProject?.hoursNeeded ?? 10,
          userTrailingHours: userRepo.getTrailingHours(b.userId),
          itemTier: item.tier,
          neededTier: item.tier,
          firstTimeUser: (compUser?.trailingUsageHours ?? 0) === 0,
        };
      });

      const allRequests = [...competingRequests, myRequest];
      mediationResult = mediate(allRequests, itemRepo.findAll(), bookingRepo.findAll(), getLabDistance, now());
      status = mediationResult.winner === 'new'
        ? (item.requiresApproval ? 'pending' : 'approved')
        : 'waitlisted';
    }

    const booking = bookingRepo.create({ projectId, itemId, userId: req.user.userId, start, end, status });

    if (status === 'approved') {
      const token = generateCheckinToken(booking.id);
      bookingRepo.update(booking.id, { checkinToken: token });
      booking.checkinToken = token;
    }

    // Notify department faculty of pending approval
    if (status === 'pending') {
      const deptFaculty = userRepo.findByRole('faculty').filter(f => f.department === item.department);
      for (const f of deptFaculty) {
        notificationRepo.add(f.id, 'info',
          `New approval request for "${item.name}" from project "${project.title}".`,
          { bookingId: booking.id });
      }
    }

    let negotiationText = null;
    if (mediationResult) {
      const { text } = await geminiService.negotiationText(mediationResult, item);
      negotiationText = text;
    }

    return res.status(201).json({ booking, mediationResult, negotiationText });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/bookings/:id/approve – faculty/admin approval */
router.post('/:id/approve', requireRole('faculty', 'admin'), async (req, res, next) => {
  try {
    const booking = bookingRepo.findById(req.params.id);
    if (!booking) { return res.status(404).json({ error: 'Booking not found' }); }

    const validation = validateApprovalAction(req.body);
    if (validation.error) { return res.status(400).json({ error: validation.error }); }

    const { action, comment } = validation.value;

    const item = itemRepo.findById(booking.itemId);
    if (!item) { return res.status(404).json({ error: 'Item not found' }); }

    // Faculty can only approve items in their department
    if (req.user.role === 'faculty') {
      const facultyUser = userRepo.findById(req.user.userId);
      if (facultyUser?.department !== item.department) {
        return res.status(403).json({ error: 'You can only approve bookings for your department' });
      }
    }

    const targetStatus = action === 'approve'
      ? 'approved'
      : action === 'reject' ? 'rejected' : 'changes_requested';

    if (!isLegalTransition(booking.status, targetStatus)) {
      return res.status(409).json({
        error: `Cannot transition from ${booking.status} to ${targetStatus}`,
      });
    }

    const updated = bookingRepo.update(booking.id, {
      status: targetStatus,
      approvedBy: req.user.userId,
      approvedAt: now().toISOString(),
      comment,
    });

    if (targetStatus === 'approved') {
      const token = generateCheckinToken(booking.id);
      bookingRepo.update(booking.id, { checkinToken: token });
      updated.checkinToken = token;
    }

    // Build readiness summary
    const user    = userRepo.findById(booking.userId);
    const project = projectRepo.findById(booking.projectId);
    let readinessSummary = null;
    if (user && project && item) {
      readinessSummary = await geminiService.readinessSummary(booking, item, user, project);
    }

    notificationRepo.add(
      booking.userId,
      action === 'approve' ? 'success' : 'warning',
      `Your booking for "${item?.name}" was ${targetStatus}.${comment ? ` Comment: ${comment}` : ''}`,
      { bookingId: booking.id }
    );

    return res.json({ booking: updated, readinessSummary });
  } catch (err) {
    return next(err);
  }
});

/** GET /api/bookings/:id/readiness */
router.get('/:id/readiness', requireRole('faculty', 'admin'), async (req, res, next) => {
  try {
    const booking = bookingRepo.findById(req.params.id);
    if (!booking) { return res.status(404).json({ error: 'Booking not found' }); }

    const item    = itemRepo.findById(booking.itemId);
    const user    = userRepo.findById(booking.userId);
    const project = projectRepo.findById(booking.projectId);
    if (!item || !user || !project) { return res.status(404).json({ error: 'Related data not found' }); }

    const summary = await geminiService.readinessSummary(booking, item, user, project);
    return res.json(summary);
  } catch (err) {
    return next(err);
  }
});

/** GET /api/bookings/:id/qr */
router.get('/:id/qr', requireAuth, async (req, res, next) => {
  try {
    const booking = bookingRepo.findById(req.params.id);
    if (!booking) { return res.status(404).json({ error: 'Booking not found' }); }
    if (booking.status !== 'approved') { return res.status(409).json({ error: 'Booking is not approved' }); }

    const { role, userId } = req.user;
    if (role === 'student' && booking.userId !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const token = booking.checkinToken ?? generateCheckinToken(booking.id);
    if (!booking.checkinToken) { bookingRepo.update(booking.id, { checkinToken: token }); }

    const svg = await QRCode.toString(token, { type: 'svg', margin: 2 });
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(svg);
  } catch (err) {
    return next(err);
  }
});

export default router;
