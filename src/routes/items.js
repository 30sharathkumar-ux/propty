/**
 * src/routes/items.js
 * Equipment search, item detail, and smart kit bundling.
 */

import { Router } from 'express';
import { search, getCompatibleBundle } from '../search/index.js';
import { itemRepo } from '../repo/index.js';
import { getLabDistance } from '../repo/index.js';
import { validateSearchQuery } from '../validation/index.js';
import { requireAuth } from '../middleware/index.js';
import { sweepNoShows } from '../services/noshow.js';

const router = Router();

/**
 * GET /api/items  – search items
 * Query params: q, department, category, status, tier, page, pageSize
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    sweepNoShows(); // lazy no-show sweep
    const validation = validateSearchQuery(req.query);
    if (validation.error) { return res.status(400).json({ error: validation.error }); }

    const result = await search(req.query);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/items/:id  – item detail
 */
router.get('/:id', requireAuth, (req, res) => {
  const item = itemRepo.findById(req.params.id);
  if (!item) { return res.status(404).json({ error: 'Item not found' }); }
  return res.json({ item });
});

/**
 * GET /api/items/:id/bundle  – smart kit bundling
 * Returns compatible items sorted by lab distance.
 */
router.get('/:id/bundle', requireAuth, (req, res) => {
  const item = itemRepo.findById(req.params.id);
  if (!item) { return res.status(404).json({ error: 'Item not found' }); }
  const bundle = getCompatibleBundle(item, getLabDistance);
  return res.json({ bundle, primaryItem: item });
});

export default router;
