const MIGRATIONS = [
  {
    version: 1,
    name: "persistent-jobs",
    up(database) {
      database.run(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          mode TEXT,
          status TEXT NOT NULL CHECK(status IN ('queued','running','paused','done','error','cancelled','interrupted')),
          total INTEGER NOT NULL DEFAULT 0,
          completed INTEGER NOT NULL DEFAULT 0,
          succeeded INTEGER NOT NULL DEFAULT 0,
          failed INTEGER NOT NULL DEFAULT 0,
          current TEXT NOT NULL DEFAULT '',
          failures TEXT NOT NULL DEFAULT '[]',
          payload TEXT NOT NULL DEFAULT '{}',
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          finished_at TEXT
        )
      `);
      database.run("CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at DESC)");
      database.run("CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs(type, status)");
    },
  },
  {
    version: 2,
    name: "persist-job-results",
    up(database) {
      database.run("ALTER TABLE jobs ADD COLUMN results TEXT NOT NULL DEFAULT '[]'");
    },
  },
];

export function runMigrations(database) {
  database.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const appliedRows = database.query(
    "SELECT version, name FROM schema_migrations ORDER BY version"
  ).all();
  const knownVersions = new Set(MIGRATIONS.map((migration) => migration.version));
  for (const row of appliedRows) {
    if (!knownVersions.has(row.version)) {
      throw new Error(`Database was created by a newer migration: ${row.version}`);
    }
  }
  const applied = new Map(appliedRows.map((row) => [row.version, row.name]));

  for (const migration of MIGRATIONS) {
    const appliedName = applied.get(migration.version);
    if (appliedName !== undefined) {
      if (appliedName !== migration.name) {
        throw new Error(
          `Migration ${migration.version} name mismatch: expected ${migration.name}, found ${appliedName}`
        );
      }
      continue;
    }

    database.transaction(() => {
      migration.up(database);
      database.query("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(migration.version, migration.name);
    })();
  }
}

export const migrations = MIGRATIONS.map(({ version, name }) => ({ version, name }));
