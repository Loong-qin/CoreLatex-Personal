import { Router } from 'express';
import multer from 'multer';
import { requireAdmin } from '../auth.js';
import { asyncHandler, HttpError } from '../util.js';
import { FONT_DIR } from '../services/runtimeEnvironment.js';
import { installTexVersion, TEX_VERSIONS } from '../services/texRuntimes.js';
import { getTexMirrorConfig, saveTexMirrorConfig } from '../services/texMirrors.js';
import { listRuntimeFonts, installFontFiles, installTexPackages, listRuntimeJobs, startRuntimeJob } from '../services/runtimeResources.js';

const router = Router();
router.get('/runtime-resources/fonts', asyncHandler(async (_req, res) => {
  res.json({ fonts: (await listRuntimeFonts()).map(({ file, ...font }) => font) });
}));
router.use('/admin/runtime-resources', requireAdmin);
router.get('/admin/runtime-resources', asyncHandler(async (_req, res) => {
  let fonts = [], fontError = '';
  try { fonts = await listRuntimeFonts(); } catch (error) { fontError = error.message; }
  res.json({ fonts, fontError, jobs: listRuntimeJobs(), fontDirectory: FONT_DIR });
}));
router.get('/admin/runtime-resources/tex-mirrors', asyncHandler((_req, res) => {
  res.json(getTexMirrorConfig());
}));
router.put('/admin/runtime-resources/tex-mirrors', asyncHandler((req, res) => {
  res.json(saveTexMirrorConfig(req.body));
}));
router.post('/admin/runtime-resources/tex-packages', asyncHandler(async (req, res) => {
  const { version, packages } = req.body || {};
  if (!Array.isArray(packages) || !packages.length || packages.length > 50 || packages.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9+_.-]{0,99}$/.test(name))) throw new HttpError(400, '宏包名称无效');
  res.status(202).json({ job: await startRuntimeJob('tex-packages', { version, packages }, () => installTexPackages({ version, packages })) });
}));
router.post('/admin/runtime-resources/tex-versions', asyncHandler(async (req, res) => {
  const version = String(req.body?.version || '');
  if (!TEX_VERSIONS.includes(version)) throw new HttpError(400, '不支持的 TeX Live 版本');
  res.status(202).json({ job: await startRuntimeJob('tex-version', { version }, onProgress => installTexVersion(version, { onProgress })) });
}));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 12 } });
router.post('/admin/runtime-resources/fonts', upload.array('files', 12), asyncHandler(async (req, res) => {
  if (!req.files?.length) throw new HttpError(400, '请选择字体文件');
  res.status(202).json({ job: await startRuntimeJob('fonts', { files: req.files.map(file => file.originalname) }, () => installFontFiles(req.files)) });
}));
export default router;
