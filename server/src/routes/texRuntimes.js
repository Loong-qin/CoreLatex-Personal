import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { asyncHandler } from '../util.js';
import { listTexRuntimes, configureTexRuntime } from '../services/texRuntimes.js';
const router = Router();
router.get('/tex/runtimes', asyncHandler(async (_req,res) => res.json(listTexRuntimes())));
router.get('/admin/tex/runtimes', requireAdmin, asyncHandler(async (_req,res) => res.json(listTexRuntimes({admin:true}))));
router.patch('/admin/tex/runtimes/:version', requireAdmin, asyncHandler(async (req,res) => res.json(configureTexRuntime(req.params.version,req.body))));
export default router;
