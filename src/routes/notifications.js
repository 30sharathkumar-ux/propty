/**
 * src/routes/notifications.js
 */

import { Router } from 'express';
import { notificationRepo } from '../repo/index.js';
import { requireAuth } from '../middleware/index.js';

const router = Router();

/** GET /api/notifications – get current user's notifications */
router.get('/', requireAuth, (req, res) => {
  const notes = notificationRepo.findByUser(req.user.userId);
  res.json({ notifications: notes.slice().reverse() }); // newest first
});

/** POST /api/notifications/:id/read */
router.post('/:id/read', requireAuth, (req, res) => {
  notificationRepo.markRead(req.user.userId, req.params.id);
  res.json({ ok: true });
});

export default router;
