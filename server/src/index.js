import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { PORT, HOST, ensureDataDirs, DATA_DIR } from './config.js';
import { getDb } from './db.js';
import { initializeMaintenanceProcess, beginShutdown, maintenanceStatus } from './services/maintenance.js';
import { requireAuth } from './auth.js';
import { HttpError } from './util.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import projectRoutes from './routes/projects.js';
import fileRoutes from './routes/files.js';
import compileRoutes from './routes/compile.js';
import versionsRoutes from './routes/versions.js';
import reviewRoutes from './routes/reviews.js';
import adminRoutes from './routes/admin.js';
import runtimeResourceRoutes from './routes/runtimeResources.js';
import { activeRuntimeJobCount } from './services/runtimeResources.js';
import texRuntimeRoutes from './routes/texRuntimes.js';
import aiRoutes, { settingsRouter as aiSettingsRoutes } from './routes/ai.js';
import { setupCollab, closeCollabForShutdown } from './collab.js';
import { migratePendingReviews } from './services/agent/changesets.js';
import { installFetchShim } from './fetchShim.js';
import { cleanupOrphanArtifacts } from './services/agent/artifacts.js';

// fetch 端口兜底:必须最先安装,模型网关可能落在 Node fetch 的受限端口段(如 6667)
installFetchShim();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let shutdownRequested = false;

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'CoreLatex', maintenanceProtocol: 1, shuttingDown: shutdownRequested }));
  app.use((_req, res, next) => shutdownRequested
    ? res.status(503).json({ error: '服务正在安全重启，请稍后重试。' }) : next());
  app.use('/api/auth', authRoutes);
  app.use('/api/users', requireAuth, userRoutes);
  app.use('/api/projects', requireAuth, projectRoutes);
  app.use('/api/projects', requireAuth, fileRoutes);
  app.use('/api/projects', requireAuth, compileRoutes);
  app.use('/api/projects', requireAuth, versionsRoutes);
  app.use('/api/projects', requireAuth, reviewRoutes);
  app.use('/api/projects', requireAuth, aiRoutes);
  app.use('/api/settings', requireAuth, aiSettingsRoutes);
  app.use('/api/admin', requireAuth, adminRoutes);
  app.use('/api', requireAuth, runtimeResourceRoutes);
  app.use('/api', requireAuth, texRuntimeRoutes);

  // 生产模式：托管前端构建产物
  const dist = path.resolve(__dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api|\/collab).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // 统一错误处理
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: '请求体过大' });
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超出大小限制' });
    console.error('[server error]', err);
    res.status(500).json({ error: '服务器内部错误' });
  });

  return app;
}

export function startServer(port = PORT, host = HOST) {
  ensureDataDirs();
  initializeMaintenanceProcess(getDb());
  cleanupOrphanArtifacts();
  // 滚动审阅迁移：遗留未确认变更集重新应用 + 建立审阅基线（一次性、幂等）
  migratePendingReviews();
  const app = createApp();
  const server = http.createServer(app);
  setupCollab(server);
  server.listen(port, host);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = startServer();
  let retry, closing = false;
  const shutdown = () => {
    if (closing) return;
    clearTimeout(retry);
    if (!shutdownRequested) {
      // Detached SSE observers do not own run lifetime. Keep the API usable
      // while an admitted run awaits a user answer or compile cleanup finishes.
      // Once empty, checking and closing admission happen in one sync tick.
      try {
        const work = maintenanceStatus(getDb());
        if (work.runs.length || work.compiles.length || activeRuntimeJobCount()) {
          console.error(`[shutdown] 等待已启动任务结束：${work.runs.length} 个智能体任务，${work.compiles.length} 个编译租约，${activeRuntimeJobCount()} 个环境安装。`);
          retry = setTimeout(shutdown, 1000);
          return;
        }
      } catch (error) {
        console.error('[shutdown] 无法确认任务是否结束，拒绝退出:', error.message);
        retry = setTimeout(shutdown, 1000);
        return;
      }
      shutdownRequested = true;
      beginShutdown();
    }
    let sockets;
    try { sockets = closeCollabForShutdown(); }
    catch (error) {
      // Never turn a failed persistence attempt into a successful exit. The
      // release helper sends TERM without a forced-kill timeout and stops the
      // rollout if this process cannot save; accepted edits remain in memory.
      console.error('[shutdown] 协作修改尚未安全落盘，保留内存并重试:', error.message);
      retry = setTimeout(shutdown, 1000);
      return;
    }
    closing = true;
    // Only already-flushed WebSockets may be terminated if a peer does not
    // acknowledge its close frame. Active HTTP responses finish normally.
    const closePeers = setTimeout(() => { for (const socket of sockets) socket.terminate(); }, 1000);
    closePeers.unref();
    server.close(error => {
      clearTimeout(closePeers);
      if (error) { console.error('[shutdown]', error.message); process.exitCode = 1; return; }
      process.exit(0);
    });
    server.closeIdleConnections?.();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.on('listening', () => {
    const addr = server.address();
    console.log(`CoreLatex server listening at http://${addr.address}:${addr.port}`);
    console.log(`数据目录: ${DATA_DIR}`);
  });
}
