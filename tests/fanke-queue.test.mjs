import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
}).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const metadataUrl = moduleUrl(compile(await readFile(new URL("../worker/file-metadata.ts", import.meta.url), "utf8")));
const collector = await import(moduleUrl(compile(await readFile(new URL("../worker/fanke-collector.ts", import.meta.url), "utf8"))
  .replace('from "./file-metadata"', `from "${metadataUrl}"`)));
const { drainFankeQueue } = await import(moduleUrl(compile(await readFile(new URL("../app/fanke-queue-client.ts", import.meta.url), "utf8"))));

async function withQueue(run) {
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-05-15", d1Databases: ["DB"],
    script: "export default { fetch() { return new Response('ok'); } }" });
  try {
    const DB = await runtime.getD1Database("DB");
    for (const name of ["0008_fanke_collector.sql", "0009_fanke_one_click_assistant.sql", "0010_fanke_category_scans.sql"]) {
      const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
      for (const statement of sql.replaceAll("--> statement-breakpoint", "").split(";").map((s) => s.trim()).filter(Boolean)) {
        await DB.prepare(statement).run();
      }
    }
    const seed = async (id, school, date, status, lastAttempt = null, nextAttempt = null) => {
      await DB.prepare(`INSERT INTO fanke_files (user_id, queue_id, form_id, submission_id, submitted_at,
        school_name, filename, download_url, kind, status, source, attempt_count, last_attempt_at,
        next_attempt_at, received_at, updated_at) VALUES ('test-user', ?, '13', ?, ?, ?, ?, ?, 'edp', ?, 'assistant', 1, ?, ?, ?, ?)`)
        .bind(id, id, date, school, `${school}.zip`, `https://download.s21i.co99.net/${id}.zip`, status,
          lastAttempt, nextAttempt, date, new Date().toISOString()).run();
    };
    const collect = async (processor) => (await collector.collectFankeNow(
      new Request("https://example.test/api/fanke/collect/edp", { method: "POST" }), { DB }, "test-user", "edp", processor)).json();
    await run({ DB, seed, collect });
  } finally {
    await runtime.dispose();
  }
}

test("seven scanned archives cannot report completion while two claimed files remain unfinished", async () => {
  await withQueue(async ({ DB, seed, collect }) => {
    const fixtures = [
      ["tianjin", "天津大学", "2026-06-14T16:36:20.000Z", "invalid"],
      ["minzu", "北方民族大学", "2026-06-15T14:59:05.000Z", "processed"],
      ["petroleum", "中国石油大学（北京）", "2026-06-20T07:14:36.000Z", "processed"],
      ["zhongshan", "中山大学", "2026-06-24T12:18:46.000Z", "processed"],
      ["ocean", "中国海洋大学", "2026-06-29T04:18:53.000Z", "processed"],
      ["karamay", "中国石油大学（北京）克拉玛依校区", "2026-06-30T11:00:09.000Z", "processing"],
      ["nanjing", "南京理工大学", "2026-07-13T14:27:33.000Z", "processing"],
    ];
    for (const row of fixtures) await seed(...row, new Date().toISOString());
    const received = [];
    const processor = async (file) => { received.push(file.schoolName); return { status: "processed" }; };
    const waiting = await collect(processor);
    assert.equal(waiting.remaining, 2, "claimed files must remain visible instead of being counted as complete");
    assert.equal(waiting.processing, 2);
    assert.equal(waiting.ready, 0, "do not spin or duplicate a live request's claims");
    assert.deepEqual(received, []);

    await DB.prepare("UPDATE fanke_files SET last_attempt_at = ? WHERE status = 'processing'")
      .bind(new Date(Date.now() - 30 * 60_000).toISOString()).run();
    const resumed = await collect(processor);
    assert.equal(resumed.processed, 1, "large EDPs must not share one request's parsing budget");
    assert.equal(resumed.remaining, 1);
    assert.equal(resumed.ready, 1, "an abandoned claim must be recoverable without rescanning Fanke");
    assert.equal((await collect(processor)).remaining, 0);
    assert.deepEqual(received, ["中国石油大学（北京）克拉玛依校区", "南京理工大学"]);
    const counts = await DB.prepare("SELECT status, COUNT(*) AS total FROM fanke_files GROUP BY status ORDER BY status").all();
    assert.deepEqual(counts.results, [{ status: "invalid", total: 1 }, { status: "processed", total: 6 }]);
  });
});

test("EDP batches finish across bounded requests without skipping, duplicating, or hiding a delayed retry", async () => {
  await withQueue(async ({ DB, seed, collect }) => {
    for (let i = 0; i < 7; i++) await seed(`file-${i}`, `测试学校${i}`, `2026-06-${String(15 + i).padStart(2, "0")}T00:00:00.000Z`, "pending");
    const received = [];
    const processor = async ({ queueId }) => { received.push(queueId); return { status: "processed" }; };
    let result = await collect(processor);
    assert.equal(result.processed, 1);
    assert.equal(result.remaining, 6);
    for (let i = 0; i < 6; i++) result = await collect(processor);
    assert.equal(result.remaining, 0);
    assert.deepEqual(received, ["file-0", "file-1", "file-2", "file-3", "file-4", "file-5", "file-6"]);
    await seed("retry", "需要重试大学", "2026-06-22T00:00:00.000Z", "retry", null, new Date(Date.now() + 60_000).toISOString());
    result = await collect(processor);
    assert.equal(result.remaining, 1);
    assert.equal(result.waitingRetry, 1);
    assert.equal(result.ready, 0);
    await DB.prepare("UPDATE fanke_files SET next_attempt_at = NULL WHERE queue_id = 'retry'").run();
    assert.equal((await collect(processor)).remaining, 0);
    assert.equal(received.at(-1), "retry");
  });
});

test("the browser drains all seven EDPs then stops on a live claim instead of requesting 200 empty batches", async () => {
  await withQueue(async ({ DB, seed, collect }) => {
    for (let i = 0; i < 7; i++) await seed(`batch-${i}`, `批量学校${i}`, `2026-06-${String(15 + i).padStart(2, "0")}T00:00:00.000Z`, "pending");
    const received = [];
    let requests = 0;
    const next = () => { requests++; return collect(async ({ queueId }) => { received.push(queueId); return { status: "processed" }; }); };
    const result = await drainFankeQueue(next);
    assert.equal(result.processed, 7);
    assert.equal(result.remaining, 0);
    assert.equal(requests, 7);
    assert.equal(new Set(received).size, 7);
    await seed("live", "处理中大学", "2026-06-22T00:00:00.000Z", "processing", new Date().toISOString());
    const waiting = await drainFankeQueue(next);
    assert.equal(waiting.remaining, 1);
    assert.equal(waiting.processing, 1);
    assert.equal(requests, 8, "wait for the lease instead of spinning or stealing the active claim");
    const row = await DB.prepare("SELECT status, attempt_count FROM fanke_files WHERE queue_id = 'live'").first();
    assert.deepEqual(row, { status: "processing", attempt_count: 1 });
  });
});

test("concurrent collection requests cannot steal an active EDP claim", async () => {
  await withQueue(async ({ seed, collect }) => {
    await seed("concurrent", "并发测试大学", "2026-06-15T00:00:00.000Z", "pending");
    let release;
    let claimed;
    const entered = new Promise((resolve) => { claimed = resolve; });
    const hold = new Promise((resolve) => { release = resolve; });
    const first = collect(async () => { claimed(); await hold; return { status: "processed" }; });
    await entered;
    try {
      const second = await collect(async () => { assert.fail("an active claim must never be downloaded twice"); });
      assert.equal(second.processed, 0);
      assert.equal(second.remaining, 1);
      assert.equal(second.processing, 1);
      assert.equal(second.ready, 0);
    } finally {
      release();
    }
    assert.equal((await first).processed, 1);
  });
});
