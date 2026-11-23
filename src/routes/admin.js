/**
 * src/routes/admin.js
 * Admin-only: simulated time control (DEMO_MODE), clock set.
 */

import { Router } from 'express';
import { requireRole } from '../middleware/index.js';
import { setClock, now, DEMO_MODE } from '../config.js';
import { validateClockSet } from '../validation/index.js';

const router = Router();

/** POST /api/admin/clock – set simulated time (DEMO_MODE only, admin only) */
router.post('/clock', requireRole('admin'), (req, res) => {
  if (!DEMO_MODE) {
    return res.status(403).json({ error: 'Clock simulation is only available in DEMO_MODE' });
  }
  const validation = validateClockSet(req.body);
  if (validation.error) { return res.status(400).json({ error: validation.error }); }

  setClock(new Date(validation.value.isoDate));
  return res.json({ ok: true, now: now().toISOString() });
});

/** DELETE /api/admin/clock – reset to real clock */
router.delete('/clock', requireRole('admin'), (req, res) => {
  if (!DEMO_MODE) {
    return res.status(403).json({ error: 'Clock simulation is only available in DEMO_MODE' });
  }
  setClock(null);
  return res.json({ ok: true, now: now().toISOString() });
});

/** GET /api/admin/clock */
router.get('/clock', requireRole('admin'), (req, res) => {
  res.json({ now: now().toISOString(), demoMode: DEMO_MODE });
});

export default router;
