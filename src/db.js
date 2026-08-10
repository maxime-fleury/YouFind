import { Database } from "bun:sqlite";
import { join } from "path";
import { runMigrations } from "./migrations.js";

const DB_PATH = join(import.meta.dir, "..", "youfind.db");

const db = new Database(DB_PATH);

db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA foreign_keys = ON;");

function ensureColumn(table, column, definition) {
  const exists = db.query(`PRAGMA table_info(${table})`).all()
    .some((entry) => entry.name === column);
  if (!exists) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

db.run(`
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    channel_id TEXT NOT NULL UNIQUE,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','validated','rejected')),
    date_ajout TEXT DEFAULT (datetime('now')),
    raison_rejet TEXT,
    subscriber_count INTEGER DEFAULT 0,
    last_video_date TEXT,
    llm_summary TEXT,
    llm_score REAL,
    thumbnail TEXT,
    description TEXT
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    titre TEXT NOT NULL,
    description TEXT,
    url TEXT NOT NULL UNIQUE,
    thumbnail TEXT,
    date_pub TEXT,
    vues INTEGER DEFAULT 0,
    duration INTEGER DEFAULT 0,
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
  );
`);

// Legacy schema migrations are explicit and fail loudly instead of hiding
// unrelated SQLite errors behind a broad catch.
ensureColumn("videos", "duration", "INTEGER DEFAULT 0");
// Track last RSS refresh per channel so bulk refresh can skip recent runs.
ensureColumn("channels", "last_refresh", "TEXT");
// Store the channel description for scoring channels without videos.
ensureColumn("channels", "description", "TEXT");

db.run(`
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    description TEXT,
    date_ajout TEXT DEFAULT (datetime('now')),
    display_order INTEGER DEFAULT 0
  );
`);

// Migration: add display_order column for existing databases.
ensureColumn("topics", "display_order", "INTEGER DEFAULT 0");

db.run(`
  CREATE TABLE IF NOT EXISTS feedback_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    channel_nom TEXT,
    decision TEXT NOT NULL CHECK(decision IN ('validated','rejected')),
    raison TEXT,
    date_decision TEXT DEFAULT (datetime('now'))
  );
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_videos_date ON videos(date_pub DESC);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_videos_channel_date ON videos(channel_id, date_pub DESC);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_channels_score ON channels(llm_score DESC);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_feedback_channel ON feedback_log(channel_id);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_feedback_decision_date ON feedback_log(decision, date_decision DESC);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_videos_duration ON videos(duration);`);

db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS channel_topics (
    channel_id TEXT NOT NULL,
    topic_id INTEGER NOT NULL,
    PRIMARY KEY (channel_id, topic_id),
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
  );
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_ct_topic ON channel_topics(topic_id);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_ct_channel ON channel_topics(channel_id);`);

db.run(`
  CREATE TABLE IF NOT EXISTS watched_videos (
    url TEXT PRIMARY KEY,
    watched_at TEXT DEFAULT (datetime('now'))
  );
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_watched_at ON watched_videos(watched_at DESC);`);

// Infrastructure schema is versioned separately from the legacy bootstrap above.
// Run it before FTS repair and data backfills so incompatible databases fail early.
runMigrations(db);

// --- FTS5 full-text search index for videos ---
db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
    titre,
    description,
    channel_nom,
    tokenize='unicode61'
  );
`);

db.run(`DROP TRIGGER IF EXISTS videos_fts_ai;`);
db.run(`DROP TRIGGER IF EXISTS videos_fts_ad;`);
db.run(`DROP TRIGGER IF EXISTS videos_fts_au;`);
db.run(`DROP TRIGGER IF EXISTS channels_fts_au;`);

db.run(`
  CREATE TRIGGER videos_fts_ai AFTER INSERT ON videos
  BEGIN
    INSERT INTO videos_fts(rowid, titre, description, channel_nom)
    VALUES (new.id, new.titre, new.description, (SELECT nom FROM channels WHERE channel_id = new.channel_id));
  END;

  CREATE TRIGGER videos_fts_ad AFTER DELETE ON videos
  BEGIN
    DELETE FROM videos_fts WHERE rowid = old.id;
  END;

  CREATE TRIGGER videos_fts_au AFTER UPDATE ON videos
  BEGIN
    UPDATE videos_fts
    SET titre = new.titre,
        description = new.description,
        channel_nom = (SELECT nom FROM channels WHERE channel_id = new.channel_id)
    WHERE rowid = old.id;
  END;

  CREATE TRIGGER channels_fts_au AFTER UPDATE OF nom ON channels
  BEGIN
    UPDATE videos_fts
    SET channel_nom = new.nom
    WHERE rowid IN (SELECT id FROM videos WHERE channel_id = new.channel_id);
  END;
`);

// Backfill existing videos if the FTS index is empty
try {
  const ftsCount = db.query("SELECT count(*) as c FROM videos_fts").get().c;
  if (ftsCount === 0) {
    console.log("[DB] Backfilling FTS index...");
    db.run(`
      INSERT INTO videos_fts(rowid, titre, description, channel_nom)
      SELECT v.id, v.titre, v.description, c.nom
      FROM videos v JOIN channels c ON v.channel_id = c.channel_id;
    `);
    console.log("[DB] FTS index backfilled.");
  }
} catch (e) {
  console.error("[DB] Failed to backfill FTS index:", e.message);
}

// --- FTS5 full-text search index for channels (trigram => substring search) ---
// Standalone FTS5 table (no content= linkage). Keep it synchronized with
// triggers and repair it only when the cheap consistency check detects drift.
function createChannelsFtsSchema() {
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS channels_fts USING fts5(
      nom,
      tokenize='trigram'
    );
  `);

  // NOTE: trigger names are prefixed (channels_fts_idx_*) to avoid clobbering the
  // pre-existing channels_fts_au trigger that syncs videos_fts on channel rename.
  db.run(`
    CREATE TRIGGER IF NOT EXISTS channels_fts_idx_ai AFTER INSERT ON channels
    BEGIN
      INSERT INTO channels_fts(rowid, nom) VALUES (new.id, new.nom);
    END;

    CREATE TRIGGER IF NOT EXISTS channels_fts_idx_ad AFTER DELETE ON channels
    BEGIN
      DELETE FROM channels_fts WHERE rowid = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS channels_fts_idx_au AFTER UPDATE OF nom ON channels
    BEGIN
      DELETE FROM channels_fts WHERE rowid = old.id;
      INSERT INTO channels_fts(rowid, nom) VALUES (new.id, new.nom);
    END;
  `);
}

function rebuildChannelsFts() {
  db.run(`DROP TRIGGER IF EXISTS channels_fts_idx_ai;`);
  db.run(`DROP TRIGGER IF EXISTS channels_fts_idx_ad;`);
  db.run(`DROP TRIGGER IF EXISTS channels_fts_idx_au;`);
  db.run(`DROP TABLE IF EXISTS channels_fts;`);
  createChannelsFtsSchema();
  db.run(`INSERT INTO channels_fts(rowid, nom) SELECT id, nom FROM channels;`);
}

function ensureChannelsFts() {
  createChannelsFtsSchema();
  const channelCount = db.query("SELECT count(*) AS count FROM channels").get().count;
  const indexedCount = db.query("SELECT count(*) AS count FROM channels_fts").get().count;
  const hasMismatch = db.query(`
    SELECT 1
    FROM channels c
    LEFT JOIN channels_fts f ON f.rowid = c.id
    WHERE f.rowid IS NULL OR f.nom != c.nom
    LIMIT 1
  `).get();
  if (channelCount !== indexedCount || hasMismatch) {
    db.run("DELETE FROM channels_fts");
    db.run("INSERT INTO channels_fts(rowid, nom) SELECT id, nom FROM channels");
    console.log("[DB] Channels FTS index repaired.");
  }
}

try {
  ensureChannelsFts();
} catch (e) {
  console.error("[DB] Failed to verify channels FTS index:", e.message);
}

// Backfill rejected channels from feedback_log (for historical data before we kept channels in DB)
try {
  const rejectedCount = db.query(`SELECT count(*) as c FROM channels WHERE status = 'rejected'`).get().c;
  if (rejectedCount === 0) {
    console.log("[DB] Backfilling rejected channels from feedback_log...");
    db.run(`
      INSERT OR IGNORE INTO channels (nom, channel_id, status, raison_rejet, date_ajout)
      SELECT DISTINCT
        COALESCE(channel_nom, 'Inconnu') as nom,
        channel_id,
        'rejected' as status,
        raison as raison_rejet,
        date_decision as date_ajout
      FROM feedback_log
      WHERE decision = 'rejected'
    `);
    const added = db.query(`SELECT changes() as c`).get().c;
    console.log(`[DB] ${added} rejected channels backfilled.`);
  }
} catch (e) {
  console.error("[DB] Failed to backfill rejected channels:", e.message);
}

const DEFAULT_SETTINGS = {
  llm_provider: "ollama",
  ollama_url: "http://localhost:11434",
  ollama_model: "llama3.2:3b",
  lmstudio_url: "http://localhost:1234",
  lmstudio_model: "default",
  openrouter_key: "",
  openrouter_model: "meta-llama/llama-3.1-8b-instruct:free",
  llm_concurrency: "3",
};

const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const setSettingStmt = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
const getAllSettingsStmt = db.prepare(`SELECT * FROM settings`);

function getSetting(key, fallback) {
  const row = getSettingStmt.get(key);
  if (row) return row.value;
  if (fallback !== undefined) return fallback;
  return DEFAULT_SETTINGS[key] || "";
}

function setSetting(key, value) {
  setSettingStmt.run(key, value);
}

function getAllSettings() {
  const rows = getAllSettingsStmt.all();
  const settings = {};
  for (const k in DEFAULT_SETTINGS) {
    const row = rows.find((r) => r.key === k);
    settings[k] = row ? row.value : DEFAULT_SETTINGS[k];
  }
  return settings;
}

function initSettings() {
  const rows = getAllSettingsStmt.all();
  const existing = new Set(rows.map((r) => r.key));
  for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
    if (!existing.has(key)) {
      const envVal = getEnvForSetting(key);
      setSettingStmt.run(key, envVal || val);
    }
  }
}

function getEnvForSetting(key) {
  const map = {
    llm_provider: "LLM_PROVIDER",
    ollama_url: "OLLAMA_URL",
    ollama_model: "OLLAMA_MODEL",
    lmstudio_url: "LMSTUDIO_URL",
    lmstudio_model: "LMSTUDIO_MODEL",
    openrouter_key: "OPENROUTER_KEY",
    openrouter_model: "OPENROUTER_MODEL",
  };
  return Bun.env[map[key]] || "";
}

initSettings();

// --- Prepared statements ---

const stmts = {
  insertChannel: db.prepare(`
    INSERT OR IGNORE INTO channels (nom, channel_id, subscriber_count, last_video_date, thumbnail, description)
    VALUES ($nom, $channel_id, $subscriber_count, $last_video_date, $thumbnail, $description)
  `),
  upsertImportedChannel: db.prepare(`
    INSERT INTO channels
      (nom, channel_id, status, date_ajout, raison_rejet, subscriber_count, last_video_date, llm_summary, llm_score, thumbnail, description, last_refresh)
    VALUES
      ($nom, $channel_id, $status, $date_ajout, $raison_rejet, $subscriber_count, $last_video_date, $llm_summary, $llm_score, $thumbnail, $description, $last_refresh)
    ON CONFLICT(channel_id) DO UPDATE SET
      nom = excluded.nom,
      status = excluded.status,
      date_ajout = excluded.date_ajout,
      raison_rejet = excluded.raison_rejet,
      subscriber_count = excluded.subscriber_count,
      last_video_date = excluded.last_video_date,
      llm_summary = excluded.llm_summary,
      llm_score = excluded.llm_score,
      thumbnail = excluded.thumbnail,
      description = excluded.description,
      last_refresh = excluded.last_refresh
  `),

  getChannelByYoutubeId: db.prepare(`SELECT * FROM channels WHERE channel_id = ?`),
  getChannelsByStatus: db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.channel_id) as video_count FROM channels c WHERE c.status = ? ORDER BY c.date_ajout DESC`),
  getAllChannels: db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.channel_id) as video_count FROM channels c ORDER BY c.date_ajout DESC`),
  getPendingChannels: db.prepare(`SELECT * FROM channels WHERE status = 'pending' ORDER BY llm_score DESC NULLS LAST`),
  getPendingChannelsWithoutVideos: db.prepare(`
    SELECT c.* FROM channels c
    WHERE c.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM videos v WHERE v.channel_id = c.channel_id)
    ORDER BY c.date_ajout DESC
  `),
  getUnscoredChannels: db.prepare(`SELECT * FROM channels WHERE llm_score IS NULL ORDER BY date_ajout DESC`),

  updateChannelStatus: db.prepare(`UPDATE channels SET status = $status WHERE id = $id`),
  updateChannelRejection: db.prepare(`UPDATE channels SET status = 'rejected', raison_rejet = $raison WHERE id = $id`),
  resetAllScores: db.prepare(`UPDATE channels SET llm_score = NULL, llm_summary = NULL`),

  updateChannelLLM: db.prepare(`UPDATE channels SET llm_score = $llm_score, llm_summary = $llm_summary WHERE id = $id`),
  updateChannelStats: db.prepare(`UPDATE channels SET subscriber_count = $subscriber_count, last_video_date = $last_video_date WHERE channel_id = $channel_id`),
  refreshChannelInfo: db.prepare(`UPDATE channels SET nom = $nom, subscriber_count = $subscriber_count, thumbnail = $thumbnail, description = $description WHERE channel_id = $channel_id`),

  deleteChannelVideos: db.prepare(`DELETE FROM videos WHERE channel_id = ?`),
  deleteChannelFeedback: db.prepare(`DELETE FROM feedback_log WHERE channel_id = ?`),
  deleteChannel: db.prepare(`DELETE FROM channels WHERE id = ?`),

  insertVideo: db.prepare(`
    INSERT INTO videos (channel_id, titre, description, url, thumbnail, date_pub, vues, duration)
    VALUES ($channel_id, $titre, $description, $url, $thumbnail, $date_pub, $vues, $duration)
    ON CONFLICT(url) DO UPDATE SET
      titre = CASE WHEN excluded.titre != '' THEN excluded.titre ELSE videos.titre END,
      description = CASE WHEN excluded.description != '' THEN excluded.description ELSE videos.description END,
      thumbnail = CASE WHEN excluded.thumbnail != '' THEN excluded.thumbnail ELSE videos.thumbnail END,
      date_pub = COALESCE(excluded.date_pub, videos.date_pub),
      vues = CASE WHEN excluded.vues > 0 THEN excluded.vues ELSE videos.vues END,
      duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE videos.duration END
  `),

  upsertImportedVideo: db.prepare(`
    INSERT INTO videos (channel_id, titre, description, url, thumbnail, date_pub, vues, duration)
    VALUES ($channel_id, $titre, $description, $url, $thumbnail, $date_pub, $vues, $duration)
    ON CONFLICT(url) DO UPDATE SET
      channel_id = excluded.channel_id,
      titre = excluded.titre,
      description = excluded.description,
      thumbnail = excluded.thumbnail,
      date_pub = excluded.date_pub,
      vues = excluded.vues,
      duration = excluded.duration
  `),

  getVideos: db.prepare(`SELECT v.*, c.nom as channel_nom FROM videos v JOIN channels c ON v.channel_id = c.channel_id WHERE c.status = 'validated' AND v.duration > 60 ORDER BY v.date_pub DESC LIMIT ? OFFSET ?`),
  getVideosByChannel: db.prepare(`SELECT v.* FROM videos v JOIN channels c ON v.channel_id = c.channel_id WHERE v.channel_id = ? AND c.status = 'validated' AND v.duration > 60 ORDER BY v.date_pub DESC LIMIT ? OFFSET ?`),
  getVideoByUrl: db.prepare(`SELECT id, duration FROM videos WHERE url = ?`),
  updateVideoDuration: db.prepare(`UPDATE videos SET duration = $duration WHERE url = $url`),
  getAllVideos: db.prepare(`SELECT * FROM videos ORDER BY id ASC`),
  getAllChannelTopics: db.prepare(`SELECT channel_id, topic_id FROM channel_topics ORDER BY channel_id, topic_id`),
  getAllFeedback: db.prepare(`SELECT * FROM feedback_log ORDER BY id ASC`),
  insertFeedbackExport: db.prepare(`
    INSERT INTO feedback_log (channel_id, channel_nom, decision, raison, date_decision)
    VALUES ($channel_id, $channel_nom, $decision, $raison, COALESCE($date_decision, datetime('now')))
  `),
  updateChannelLastRefresh: db.prepare(`UPDATE channels SET last_refresh = ? WHERE channel_id = ?`),

  insertTopic: db.prepare(`INSERT INTO topics (nom, description) VALUES ($nom, $description)`),
  getAllTopics: db.prepare(`SELECT * FROM topics ORDER BY display_order ASC, date_ajout DESC`),
  updateTopicOrder: db.prepare(`UPDATE topics SET display_order = ? WHERE id = ?`),
  deleteTopic: db.prepare(`DELETE FROM topics WHERE id = ?`),

  insertFeedback: db.prepare(`INSERT INTO feedback_log (channel_id, channel_nom, decision, raison) VALUES ($channel_id, $channel_nom, $decision, $raison)`),
  getRecentRejections: db.prepare(`
    SELECT fl.*, c.nom as current_channel_nom 
    FROM feedback_log fl 
    LEFT JOIN channels c ON fl.channel_id = c.channel_id 
    WHERE fl.decision = 'rejected' 
    ORDER BY fl.date_decision DESC 
    LIMIT ?
  `),
  getFeedbackForPrompt: db.prepare(`
    SELECT raison, channel_nom 
    FROM feedback_log 
    WHERE decision = 'rejected' AND raison IS NOT NULL AND raison != ''
    ORDER BY date_decision DESC 
    LIMIT 20
  `),

  getStats: db.prepare(`
    SELECT
      COUNT(*) as total_channels,
      SUM(CASE WHEN status = 'validated' THEN 1 ELSE 0 END) as validated_channels,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_channels,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected_channels,
      (SELECT COUNT(*) FROM feedback_log WHERE decision = 'rejected') as rejected_feedback_events,
      ROUND(100.0 * SUM(CASE WHEN status = 'validated' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as validated_channel_ratio,
      (SELECT COUNT(*) FROM videos v JOIN channels c ON v.channel_id = c.channel_id WHERE c.status = 'validated' AND v.duration > 60) as total_videos,
      (SELECT COUNT(*) FROM topics) as total_topics
    FROM channels
  `),

  // Channel-Topic junction
  assignTopic: db.prepare(`INSERT OR IGNORE INTO channel_topics (channel_id, topic_id) VALUES (?, ?)`),
  removeTopic: db.prepare(`DELETE FROM channel_topics WHERE channel_id = ? AND topic_id = ?`),
  getChannelTopics: db.prepare(`SELECT t.* FROM topics t JOIN channel_topics ct ON t.id = ct.topic_id WHERE ct.channel_id = ?`),
  getTopicChannels: db.prepare(`SELECT c.* FROM channels c JOIN channel_topics ct ON c.channel_id = ct.channel_id WHERE ct.topic_id = ? AND c.status = 'validated'`),
  getVideosByTopic: db.prepare(`
    SELECT DISTINCT v.*, c.nom as channel_nom
    FROM videos v
    JOIN channels c ON v.channel_id = c.channel_id
    JOIN channel_topics ct ON v.channel_id = ct.channel_id
    WHERE ct.topic_id = ? AND c.status = 'validated' AND v.duration > 60
    ORDER BY v.date_pub DESC
    LIMIT ? OFFSET ?
  `),
  getVideosWithoutTopic: db.prepare(`
    SELECT DISTINCT v.*, c.nom as channel_nom
    FROM videos v
    JOIN channels c ON v.channel_id = c.channel_id
    WHERE NOT EXISTS (SELECT 1 FROM channel_topics ct WHERE ct.channel_id = v.channel_id)
      AND c.status = 'validated' AND v.duration > 60
    ORDER BY v.date_pub DESC
    LIMIT ? OFFSET ?
  `),

  getRejectedFromFeedback: db.prepare(`
    SELECT DISTINCT
      fl.channel_id as channel_id,
      fl.channel_nom as nom,
      'rejected' as status,
      fl.raison as raison_rejet,
      fl.date_decision as date_ajout,
      COALESCE((SELECT c.id FROM channels c WHERE c.channel_id = fl.channel_id), -1) as id
    FROM feedback_log fl
    WHERE fl.decision = 'rejected'
    ORDER BY fl.date_decision DESC
  `),

  getBlacklistedChannelIds: db.prepare(`
    SELECT DISTINCT channel_id FROM feedback_log WHERE decision = 'rejected'
  `),

  insertWatchedVideo: db.prepare(`INSERT OR IGNORE INTO watched_videos (url) VALUES (?)`),
  deleteWatchedVideo: db.prepare(`DELETE FROM watched_videos WHERE url = ?`),
  getAllWatchedVideos: db.prepare(`SELECT url FROM watched_videos ORDER BY watched_at DESC`),
};

export { db, stmts, getSetting, setSetting, getAllSettings, rebuildChannelsFts };
