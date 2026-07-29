import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "..", "youfind.db");

const db = new Database(DB_PATH);

db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA foreign_keys = ON;");

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
    thumbnail TEXT
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

// Migration: add duration column for existing databases
try { db.run("ALTER TABLE videos ADD COLUMN duration INTEGER DEFAULT 0"); } catch {}

db.run(`
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    description TEXT,
    date_ajout TEXT DEFAULT (datetime('now'))
  );
`);

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

const DEFAULT_SETTINGS = {
  youtube_api_key: "",
  llm_provider: "ollama",
  ollama_url: "http://localhost:11434",
  ollama_model: "llama3.2:3b",
  lmstudio_url: "http://localhost:1234",
  lmstudio_model: "default",
  openrouter_key: "",
  openrouter_model: "meta-llama/llama-3.1-8b-instruct:free",
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
    youtube_api_key: "YOUTUBE_API_KEY",
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
    INSERT OR IGNORE INTO channels (nom, channel_id, subscriber_count, last_video_date, thumbnail)
    VALUES ($nom, $channel_id, $subscriber_count, $last_video_date, $thumbnail)
  `),

  getChannelByYoutubeId: db.prepare(`SELECT * FROM channels WHERE channel_id = ?`),
  getChannelsByStatus: db.prepare(`SELECT * FROM channels WHERE status = ? ORDER BY date_ajout DESC`),
  getAllChannels: db.prepare(`SELECT * FROM channels ORDER BY date_ajout DESC`),
  getPendingChannels: db.prepare(`SELECT * FROM channels WHERE status = 'pending' ORDER BY llm_score DESC NULLS LAST`),
  getUnscoredChannels: db.prepare(`SELECT * FROM channels WHERE llm_score IS NULL ORDER BY date_ajout DESC`),

  updateChannelStatus: db.prepare(`UPDATE channels SET status = $status WHERE id = $id`),
  updateChannelRejection: db.prepare(`UPDATE channels SET status = 'rejected', raison_rejet = $raison WHERE id = $id`),
  resetAllScores: db.prepare(`UPDATE channels SET llm_score = NULL, llm_summary = NULL`),

  updateChannelLLM: db.prepare(`UPDATE channels SET llm_score = $llm_score, llm_summary = $llm_summary WHERE id = $id`),
  updateChannelStats: db.prepare(`UPDATE channels SET subscriber_count = $subscriber_count, last_video_date = $last_video_date WHERE channel_id = $channel_id`),
  refreshChannelInfo: db.prepare(`UPDATE channels SET nom = $nom, subscriber_count = $subscriber_count, thumbnail = $thumbnail WHERE channel_id = $channel_id`),

  deleteChannelVideos: db.prepare(`DELETE FROM videos WHERE channel_id = ?`),
  deleteChannelFeedback: db.prepare(`DELETE FROM feedback_log WHERE channel_id = ?`),
  deleteChannel: db.prepare(`DELETE FROM channels WHERE id = ?`),

  insertVideo: db.prepare(`
    INSERT OR IGNORE INTO videos (channel_id, titre, description, url, thumbnail, date_pub, vues, duration)
    VALUES ($channel_id, $titre, $description, $url, $thumbnail, $date_pub, $vues, $duration)
  `),

  getVideos: db.prepare(`SELECT v.*, c.nom as channel_nom FROM videos v JOIN channels c ON v.channel_id = c.channel_id WHERE c.status = 'validated' AND (v.duration > 60 OR v.duration = 0) ORDER BY v.date_pub DESC LIMIT ? OFFSET ?`),
  getVideosByChannel: db.prepare(`SELECT v.* FROM videos v JOIN channels c ON v.channel_id = c.channel_id WHERE v.channel_id = ? AND c.status = 'validated' AND (v.duration > 60 OR v.duration = 0) ORDER BY v.date_pub DESC LIMIT ? OFFSET ?`),
  getVideoByUrl: db.prepare(`SELECT id, duration FROM videos WHERE url = ?`),
  updateVideoDuration: db.prepare(`UPDATE videos SET duration = $duration WHERE url = $url`),

  insertTopic: db.prepare(`INSERT INTO topics (nom, description) VALUES ($nom, $description)`),
  getAllTopics: db.prepare(`SELECT * FROM topics ORDER BY date_ajout DESC`),
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
      (SELECT COUNT(*) FROM feedback_log WHERE decision = 'rejected') as rejected_channels,
      (SELECT COUNT(*) FROM videos v JOIN channels c ON v.channel_id = c.channel_id WHERE c.status = 'validated' AND (v.duration > 60 OR v.duration = 0)) as total_videos,
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
    WHERE ct.topic_id = ? AND c.status = 'validated' AND (v.duration > 60 OR v.duration = 0)
    ORDER BY v.date_pub DESC
    LIMIT ? OFFSET ?
  `),
  getVideosWithoutTopic: db.prepare(`
    SELECT DISTINCT v.*, c.nom as channel_nom
    FROM videos v
    JOIN channels c ON v.channel_id = c.channel_id
    WHERE NOT EXISTS (SELECT 1 FROM channel_topics ct WHERE ct.channel_id = v.channel_id)
      AND c.status = 'validated' AND (v.duration > 60 OR v.duration = 0)
    ORDER BY v.date_pub DESC
    LIMIT ? OFFSET ?
  `),

  getBlacklistedChannelIds: db.prepare(`
    SELECT DISTINCT channel_id FROM feedback_log WHERE decision = 'rejected'
  `),
};

export { db, stmts, getSetting, setSetting, getAllSettings };
