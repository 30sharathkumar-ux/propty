/**
 * src/routes/auth.js
 * Role-switcher endpoint. Sets an HMAC-signed, httpOnly, sameSite=lax cookie.
 * In production this would be replaced by campus SSO.
 */

import { Router } from 'express';
import { ROLES, IS_PRODUCTION } from '../config.js';
import { buildRoleCookie, attachUser } from '../middleware/index.js';
import { userRepo } from '../repo/index.js';

const router = Router();

// Map roles to default user ids for the demo
const DEFAULT_USERS = {
  student:    'u-stu-alice',
  faculty:    'u-fac-cse',
  technician: 'u-tech-raj',
  admin:      'u-admin',
};

/**
 * GET /api/auth/users  – list available demo users (for role switcher UI)
 */
router.get('/users', (_req, res) => {
  const users = userRepo.findAll().map(u => ({
    id: u.id,
    name: u.name,
    role: u.role,
    department: u.department,
  }));
  res.json({ users });
});

/**
 * POST /api/auth/switch
 * Body: { role, userId? }
 * Sets the lablink_role cookie.
 */
router.post('/switch', (req, res) => {
  const { role, userId } = req.body ?? {};

  if (!role || !ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  }

  const resolvedUserId = userId ?? DEFAULT_USERS[role];
  const user = userRepo.findById(resolvedUserId);
  if (!user) {
    return res.status(400).json({ error: 'Unknown userId' });
  }
  if (user.role !== role) {
    return res.status(403).json({ error: 'User role mismatch' });
  }

  const cookieVal = buildRoleCookie(role, resolvedUserId);
  res.cookie('lablink_role', cookieVal, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    maxAge: 86400 * 1000, // 1 day
  });
  return res.json({ ok: true, role, userId: resolvedUserId, name: user.name });
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (_req, res) => {
  res.clearCookie('lablink_role');
  res.json({ ok: true });
});

/**
 * GET /api/auth/me
 */
router.get('/me', attachUser, (req, res) => {
  if (!req.user) { return res.json({ authenticated: false }); }
  const user = userRepo.findById(req.user.userId);
  if (!user) { return res.json({ authenticated: false }); }
  return res.json({
    authenticated: true,
    userId: user.id,
    name: user.name,
    role: user.role,
    department: user.department,
  });
});

export default router;
