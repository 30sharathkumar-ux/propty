/**
 * src/routes/analytics.js
 */

import { Router } from 'express';
import { computeAnalytics } from '../services/analytics.js';
import { requireRole } from '../middleware/index.js';
import { sweepNoShows } from '../services/noshow.js';

const router = Router();

/** GET /api/analytics */
router.get('/', requireRole('faculty', 'admin', 'technician'), (req, res) => {
  sweepNoShows();
  const data = computeAnalytics();
  res.json(data);
});

export default router;
