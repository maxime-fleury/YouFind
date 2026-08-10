import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { migrations, runMigrations } from "../src/migrations.js";
import { createJobRepository } from "../src/job-repository.js";

const databases = [];

function createRepository() {
  const database = new Database(":memory:");
  runMigrations(database);
  databases.push(database);
  return { database, repository: createJobRepository(database) };
}

afterEach(() => {
  while (databases.length) databases.pop().close();
});

describe("database migrations", () => {
  test("apply all migrations once and remain idempotent", () => {
    const database = new Database(":memory:");
    databases.push(database);

    runMigrations(database);
    runMigrations(database);

    expect(database.query("SELECT version, name FROM schema_migrations ORDER BY version").all()
      .map(({ version, name }) => ({ version, name }))).toEqual(migrations);
    expect(database.query("PRAGMA table_info(jobs)").all().some((column) => column.name === "results")).toBe(true);
  });

  test("reject an incompatible migration history", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.run("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    database.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'wrong', datetime('now'))").run();

    expect(() => runMigrations(database)).toThrow("name mismatch");

    database.query("UPDATE schema_migrations SET name = 'future' WHERE version = 1").run();
    database.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'future', datetime('now'))").run();
    expect(() => runMigrations(database)).toThrow("newer migration");
  });
});

describe("persistent job repository", () => {
  test("stores progress and returns persisted discovery results", () => {
    const { repository } = createRepository();
    repository.createJob({
      id: "job-1",
      type: "related-discovery",
      payload: { passes: 2 },
    });
    repository.updateJob("job-1", {
      total: 4,
      completed: 2,
      succeeded: 1,
      current: "Channel A",
      results: [{ channelId: "UC123" }],
    });

    expect(repository.getJob("job-1", "related-discovery")).toMatchObject({
      status: "running",
      total: 4,
      completed: 2,
      succeeded: 1,
      payload: { passes: 2 },
      results: [{ channelId: "UC123" }],
    });
    expect(repository.getJob("job-1", "scoring")).toBeNull();
  });

  test("marks active jobs as interrupted and supports terminal states", () => {
    const { repository } = createRepository();
    repository.createJob({ id: "job-2", type: "scoring", mode: "unscored" });

    expect(repository.recoverInterruptedJobs()).toBe(1);
    expect(repository.getJob("job-2")).toMatchObject({
      status: "interrupted",
      error: "Process interrupted before completion",
    });
    expect(() => repository.finishJob("job-2", "running")).toThrow("terminal");
    expect(repository.finishJob("job-2", "error", { error: "LLM unavailable" })).toMatchObject({
      status: "error",
      error: "LLM unavailable",
    });
  });
});
