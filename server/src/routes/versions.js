import { Router } from 'express';
import { requireProjectAccess, touchProject } from '../access.js';
import { asyncHandler } from '../util.js';
import { createSnapshot, listVersions, getVersionDiff, restoreVersion } from '../services/versions.js';

const router = Router();

router.get('/:id/versions', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  res.json({ versions: listVersions(project.id) });
}));

router.post('/:id/versions', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const version = await createSnapshot({ project, user: req.user, message: req.body?.message });
  res.status(201).json({ version });
}));

router.get('/:id/versions/:vid', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  res.json(await getVersionDiff(project.id, req.params.vid));
}));

router.post('/:id/versions/:vid/restore', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const result = await restoreVersion(project.id, req.params.vid, { user: req.user });
  touchProject(project.id);
  res.json(result);
}));

export default router;
