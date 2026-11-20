import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { DB_PATH, ensureDataDirs } from './config.js';

let db = null;

export function getDb() {
  if (db) return db;
  ensureDataDirs();
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** 测试用：关闭并重新打开（换 DATA_DIR 后调用） */
export function resetDb() {
  if (db) { try { db.close(); } catch {} db = null; }
}

function migrate(d) {
  d.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  project_quota INTEGER NOT NULL DEFAULT -1,
  compile_seconds_quota INTEGER NOT NULL DEFAULT -1,
  compile_seconds_used REAL NOT NULL DEFAULT 0,
  storage_quota_bytes INTEGER NOT NULL DEFAULT -1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  archived INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  main_file TEXT NOT NULL DEFAULT 'main.tex',
  compile_engine TEXT NOT NULL DEFAULT 'pdflatex',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor',
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER,
  message TEXT NOT NULL,
  adds INTEGER NOT NULL DEFAULT 0,
  dels INTEGER NOT NULL DEFAULT 0,
  files TEXT NOT NULL DEFAULT '[]',
  snapshot_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  quoted_text TEXT DEFAULT '',
  content TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_by INTEGER,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS compile_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER,
  engine TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  log_path TEXT,
  published_pdf INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  title TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT DEFAULT '',
  tool_calls TEXT DEFAULT '[]',
  steps TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  project_id INTEGER,
  chat_id INTEGER,
  model TEXT DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS changesets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  chat_id INTEGER,
  proposal_revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  applied INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS changeset_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  changeset_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  before_content TEXT,
  after_content TEXT,
  content_encoding TEXT NOT NULL DEFAULT 'utf8',
  adds INTEGER NOT NULL DEFAULT 0,
  dels INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  applied INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  published_version INTEGER NOT NULL DEFAULT 0,
  changeset_id INTEGER,
  review_fingerprint TEXT,
  files_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_drafts_active
  ON agent_drafts(project_id, chat_id, user_id) WHERE state = 'active';
CREATE TRIGGER IF NOT EXISTS agent_drafts_delete_chat AFTER DELETE ON chats BEGIN
  DELETE FROM agent_drafts WHERE chat_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS agent_drafts_delete_project AFTER DELETE ON projects BEGIN
  DELETE FROM agent_drafts WHERE project_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS agent_drafts_delete_user AFTER DELETE ON users BEGIN
  DELETE FROM agent_drafts WHERE user_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS review_bases (
  project_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  base_content TEXT DEFAULT '',
  head_content TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, file_path)
);
CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY,
  ai_provider TEXT DEFAULT 'openai',
  ai_base_url TEXT DEFAULT '',
  ai_api_key TEXT DEFAULT '',
  ai_model TEXT DEFAULT '',
  chinese_support INTEGER DEFAULT 0,
  agent_config TEXT DEFAULT '{}',
  mcp_config TEXT DEFAULT '{}',
  ai_models TEXT DEFAULT '[]',
  ai_providers TEXT DEFAULT '[]',
  ai_active TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id);
CREATE INDEX IF NOT EXISTS idx_reviews_project ON reviews(project_id);
CREATE INDEX IF NOT EXISTS idx_compile_jobs_project ON compile_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id);
`);
  d.exec(`
CREATE TABLE IF NOT EXISTS agent_artifacts (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_artifacts_chat ON agent_artifacts(chat_id);
CREATE INDEX IF NOT EXISTS idx_agent_artifacts_project ON agent_artifacts(project_id);
CREATE TABLE IF NOT EXISTS maintenance_gate (
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS compile_leases (
  id TEXT PRIMARY KEY,
  process_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER,
  question TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY(run_id, seq)
);
CREATE TABLE IF NOT EXISTS agent_run_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_chat ON agent_runs(chat_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_active_chat ON agent_runs(chat_id)
  WHERE state IN ('running','waiting_for_user','cancelling');
`);
  // Process restart cannot safely replay tool side effects. Persist an explicit
  // interrupted terminal state, retaining the event log for client recovery.
  d.transaction(() => {
    for (const row of d.prepare("SELECT id,last_seq FROM agent_runs WHERE state IN ('running','waiting_for_user','cancelling')").all()) {
      const seq = row.last_seq + 1;
      d.prepare("UPDATE agent_runs SET state = 'interrupted', last_seq = ?, question = '', updated_at = datetime('now') WHERE id = ?").run(seq + 1, row.id);
      d.prepare('INSERT INTO agent_run_events(run_id,seq,event) VALUES(?,?,?)').run(row.id, seq, JSON.stringify({ type: 'run', runId: row.id, seq, state: 'interrupted' }));
      d.prepare('INSERT INTO agent_run_events(run_id,seq,event) VALUES(?,?,?)').run(row.id, seq + 1, JSON.stringify({ type: 'done', runId: row.id, seq: seq + 1, state: 'interrupted' }));
    }
  })();
  if (!d.prepare('PRAGMA table_info(changeset_files)').all().some((c) => c.name === 'content_encoding')) {
    d.exec("ALTER TABLE changeset_files ADD COLUMN content_encoding TEXT NOT NULL DEFAULT 'utf8'");
  }
  const reviewColumns = d.prepare('PRAGMA table_info(review_bases)').all();
  if (!reviewColumns.some((c) => c.name === 'head_content')) d.exec('ALTER TABLE review_bases ADD COLUMN head_content TEXT');
  if (!reviewColumns.some((c) => c.name === 'revision')) d.exec('ALTER TABLE review_bases ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  // This clock outlives individual baselines. Never reuse a revision after a
  // review is resolved, a file is deleted, or a later AI round recreates it.
  d.exec(`CREATE TABLE IF NOT EXISTS review_revision_clock (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    value INTEGER NOT NULL
  );
  INSERT INTO review_revision_clock(singleton,value)
    VALUES(1,(SELECT COALESCE(MAX(revision),0) FROM review_bases))
    ON CONFLICT(singleton) DO UPDATE SET value = MAX(value,excluded.value);`);
  // 轻量迁移：老库补 applied 列（已有 changeset 均为自动应用，默认 1 正确）
  try {
    d.exec('ALTER TABLE changesets ADD COLUMN applied INTEGER NOT NULL DEFAULT 1');
  } catch { /* 列已存在 */ }
  if (!d.prepare('PRAGMA table_info(changesets)').all().some((c) => c.name === 'proposal_revision')) {
    d.exec('ALTER TABLE changesets ADD COLUMN proposal_revision INTEGER NOT NULL DEFAULT 0');
  }
  // 逐文件记录实际应用状态：部分自动应用与部分确认不能共用父级 applied。
  // 只在缺列时回填；已确认文件即便父变更集仍未全部应用，也已经写盘。
  if (!d.prepare('PRAGMA table_info(changeset_files)').all().some((c) => c.name === 'applied')) {
    d.transaction(() => {
      d.exec('ALTER TABLE changeset_files ADD COLUMN applied INTEGER NOT NULL DEFAULT 0');
      d.exec(`UPDATE changeset_files SET applied = CASE
        WHEN status = 'accepted' THEN 1
        ELSE COALESCE((SELECT applied FROM changesets WHERE changesets.id = changeset_files.changeset_id), 0)
      END`);
    })();
  }
  // 轻量迁移：老库补 steps 列（时间线步骤，老数据为空数组）
  try {
    d.exec("ALTER TABLE chat_messages ADD COLUMN steps TEXT DEFAULT '[]'");
  } catch { /* 列已存在 */ }
  // 轻量迁移：chats 补上下文压缩摘要列（summary = 压缩摘要文本，summary_msg_id = 已压缩到的消息 id）
  try {
    d.exec('ALTER TABLE chats ADD COLUMN summary TEXT DEFAULT \'\'');
  } catch { /* 列已存在 */ }
  try {
    d.exec('ALTER TABLE chats ADD COLUMN summary_msg_id INTEGER NOT NULL DEFAULT 0');
  } catch { /* 列已存在 */ }
  if (!d.prepare('PRAGMA table_info(chats)').all().some((c) => c.name === 'context_model_key')) {
    d.exec("ALTER TABLE chats ADD COLUMN context_model_key TEXT NOT NULL DEFAULT ''");
  }
  if (!d.prepare('PRAGMA table_info(chats)').all().some((c) => c.name === 'context_usage')) {
    d.exec("ALTER TABLE chats ADD COLUMN context_usage TEXT NOT NULL DEFAULT ''");
  }
  if (!d.prepare('PRAGMA table_info(settings)').all().some((c) => c.name === 'ai_providers')) {
    d.exec("ALTER TABLE settings ADD COLUMN ai_providers TEXT DEFAULT '[]'");
  }
  // 轻量迁移：settings 补多模型配置列（ai_models = 模型条目 JSON 数组，ai_active = 当前选中 id）
  try {
    d.exec("ALTER TABLE settings ADD COLUMN ai_models TEXT DEFAULT '[]'");
  } catch { /* 列已存在 */ }
  try {
    d.exec("ALTER TABLE settings ADD COLUMN ai_active TEXT DEFAULT ''");
  } catch { /* 列已存在 */ }
  // Prior rows aggregated entire agent runs and omitted cache counters.
  // Keep their recorded tokens and identify those rows as legacy runs.
  d.transaction(() => {
    const columns = new Set(d.prepare('PRAGMA table_info(ai_usage)').all().map(c => c.name));
    const requestColumns = {
      request_key: 'TEXT',
      provider: "TEXT NOT NULL DEFAULT ''",
      provider_id: "TEXT NOT NULL DEFAULT ''",
      requested_model: "TEXT NOT NULL DEFAULT ''",
      owner: "TEXT NOT NULL DEFAULT ''",
      phase: "TEXT NOT NULL DEFAULT ''",
      status: "TEXT NOT NULL DEFAULT ''",
      usage_status: "TEXT NOT NULL DEFAULT 'legacy'",
      cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
      cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
    };
    for (const [name, definition] of Object.entries(requestColumns)) {
      if (!columns.has(name)) d.exec(`ALTER TABLE ai_usage ADD COLUMN ${name} ${definition}`);
    }
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_request_key ON ai_usage(request_key)');
    d.exec('CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id)');
    d.exec('CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at)');
  })();
  // 轻量迁移：users 补编译计时每日重置日期列（空 = 从未重置，首次校验时归零）
  try {
    d.exec("ALTER TABLE users ADD COLUMN compile_reset_date TEXT DEFAULT ''");
  } catch { /* 列已存在 */ }
  // 管理员当日补额独立保存：保留真实用量，次日自动失效。
  if (!d.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'compile_seconds_bonus')) {
    d.exec('ALTER TABLE users ADD COLUMN compile_seconds_bonus INTEGER NOT NULL DEFAULT 0');
  }
  // 轻量迁移：users 补 quota_customized 列（0=跟随系统默认配额，1=管理员单独定制过）。
  // 系统设置修改默认配额时据此同步所有未定制用户。回填一律 0（视为跟随默认）——
  // 历史上"默认值改过但用户没跟着变"与"单独定制过"在数据上无法区分，交给管理员
  // 部署后按需用编辑配额重设一次即可标记定制
  try {
    d.exec('ALTER TABLE users ADD COLUMN quota_customized INTEGER NOT NULL DEFAULT 0');
  } catch { /* 列已存在 */ }
  // 轻量迁移：chat_messages 补真实运行时长（ms）。助手行改为开跑即建行后，
  // created_at 差值恒为 0，前端「已工作 X」改读本列
  try {
    d.exec('ALTER TABLE chat_messages ADD COLUMN duration_ms INTEGER DEFAULT 0');
  } catch { /* 列已存在 */ }
  // 轻量迁移：versions 补 seq 列——版本号按项目独立编号（界面展示 v<seq>）。
  // 全局自增 id 会让新项目从 v56 这类数字起步，观感像接续了别的项目的版本历史。
  // seq 在创建时按项目内 MAX(seq)+1 分配；存量数据按项目内 id 顺序回填
  try {
    d.exec('ALTER TABLE versions ADD COLUMN seq INTEGER NOT NULL DEFAULT 0');
    d.exec(`
      UPDATE versions SET seq = (
        SELECT COUNT(*) FROM versions v2
        WHERE v2.project_id = versions.project_id AND v2.id <= versions.id
      )
    `);
    d.exec('CREATE INDEX IF NOT EXISTS idx_versions_project_seq ON versions(project_id, seq)');
  } catch { /* 列已存在 */ }
  // 轻量迁移：项目对外唯一哈希 public_id(12 位 url-safe)——对外路由/分享用它,
  // 不再暴露自增顺序编号(可被枚举相邻项目)。存量项目按随机哈希回填
  try {
    d.exec('ALTER TABLE projects ADD COLUMN public_id TEXT');
    const backfill = d.prepare('UPDATE projects SET public_id = ? WHERE id = ? AND (public_id IS NULL OR public_id = \'\')');
    const exists = d.prepare('SELECT 1 FROM projects WHERE public_id = ?');
    for (const r of d.prepare('SELECT id FROM projects').all()) {
      let h;
      do { h = randomBytes(9).toString('base64url'); } while (exists.get(h));
      backfill.run(h, r.id);
    }
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_public_id ON projects(public_id)');
  } catch { /* 列已存在 */ }
  // Preserve existing projects' actual system compiler; only new API projects
  // opt into the explicitly requested 2024 default.
  if (!d.prepare('PRAGMA table_info(projects)').all().some(c => c.name === 'tex_version')) {
    d.exec("ALTER TABLE projects ADD COLUMN tex_version TEXT NOT NULL DEFAULT 'system'");
  }
  if (!d.prepare('PRAGMA table_info(compile_jobs)').all().some(c => c.name === 'tex_version')) {
    d.exec("ALTER TABLE compile_jobs ADD COLUMN tex_version TEXT NOT NULL DEFAULT 'system'");
  }
  if (!d.prepare('PRAGMA table_info(compile_jobs)').all().some(c => c.name === 'published_pdf')) {
    d.exec('ALTER TABLE compile_jobs ADD COLUMN published_pdf INTEGER NOT NULL DEFAULT 0');
  }
  // 轻量迁移：工具/Skill 调用使用统计（独立于聊天消息——清空会话、删除消息不影响统计）
  d.exec(`
CREATE TABLE IF NOT EXISTS tool_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL DEFAULT 0,
  chat_id INTEGER NOT NULL DEFAULT 0,
  tool TEXT NOT NULL,
  skill TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tool_usage_user_created ON tool_usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_usage_project_created ON tool_usage(project_id, created_at);
`);
  // 兼容旧版 tool_usage（早期开发版用列名 name 存工具名）：统一重命名为 tool
  try {
    d.exec('ALTER TABLE tool_usage RENAME COLUMN name TO tool');
  } catch { /* 列不存在（已是 tool） */ }
  // 批注回复：批注需至少一条回复后才能标记完成
  d.exec(`
CREATE TABLE IF NOT EXISTS review_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_review_replies_review ON review_replies(review_id);
`);
}
