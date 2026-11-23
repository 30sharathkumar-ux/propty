/**
 * src/routes/projects.js
 * Project Card CRUD.
 */

import { Router } from 'express';
import { projectRepo, userRepo } from '../repo/index.js';
import { validateProject } from '../validation/index.js';
import { requireAuth } from '../middleware/index.js';

const router = Router();

/** GET /api/projects – list projects for the authenticated user */
router.get('/', requireAuth, (req, res) => {
  const { role, userId } = req.user;
  let projects;
  if (role === 'admin' || role === 'faculty' || role === 'technician') {
    projects = projectRepo.findAll();
  } else {
    projects = projectRepo.findByUser(userId);
  }
  res.json({ projects });
});

/** GET /api/projects/:id */
router.get('/:id', requireAuth, (req, res) => {
  const project = projectRepo.findById(req.params.id);
  if (!project) { return res.status(404).json({ error: 'Project not found' }); }
  // Students can only see own projects
  if (req.user.role === 'student' && !project.teamMembers.includes(req.user.userId) && project.createdBy !== req.user.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return res.json({ project });
});

/** POST /api/projects – create project */
router.post('/', requireAuth, (req, res) => {
  if (req.user.role === 'technician') {
    return res.status(403).json({ error: 'Technicians cannot create projects' });
  }
  const validation = validateProject(req.body);
  if (validation.error) { return res.status(400).json({ error: validation.error }); }

  const data = validation.value;
  // Ensure teamMembers are valid user ids
  for (const memberId of data.teamMembers) {
    if (!userRepo.findById(memberId)) {
      return res.status(400).json({ error: `Unknown team member: ${memberId}` });
    }
  }

  const project = projectRepo.create({
    ...data,
    createdBy: req.user.userId,
    teamMembers: [...new Set([req.user.userId, ...data.teamMembers])],
  });
  return res.status(201).json({ project });
});

export default router;
