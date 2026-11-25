import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { unicodeSafePrefix } from "@lark-agent/adapter-codex-app-server";
import { z } from "zod";

const positiveId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const listQuery = z.strictObject({
  messageId: positiveId.optional(), status: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)
});
const detailParams = z.object({ taskId: z.uuid() });
const fileParams = detailParams.extend({ resultId: z.uuid(), artifactId: positiveId });
const pageSize = 50;
const taskFields = `SELECT t.id, t.message_id AS messageId, t.status, t.spec,
  t.current_result AS resultId, t.review_revision AS reviewRevision,
  m.chat_type AS chatType, m.received_at AS requestedAt, c.name AS requesterName
  FROM lark_orchestration_tasks t
  LEFT JOIN lark_messages m ON m.id=t.message_id
  LEFT JOIN contacts c ON c.open_id=t.sender_id`;
type TaskRow = {
  id: string; messageId: number; status: string; spec: string; resultId: string | null; reviewRevision: number;
  chatType: string | null; requestedAt: string | null; requesterName: string | null;
};
const engineInfo = z.object({ engine: z.string(), model: z.string().optional() });
const taskSpec = z.object({ goal: z.string(), worker: engineInfo, reviewer: engineInfo.optional() });
const jobFields = "id, state, route";
type JobRow = { id: string; state: string; route: string };

function summary(row: TaskRow) {
  const spec = taskSpec.parse(JSON.parse(row.spec));
  return { id: row.id, messageId: row.messageId, status: row.status, chatType: row.chatType,
    requestedAt: row.requestedAt, requesterName: row.requesterName, worker: spec.worker,
    goal: unicodeSafePrefix(spec.goal, 200) };
}

function detail(db: Database.Database, task: TaskRow) {
  const spec = taskSpec.parse(JSON.parse(task.spec));
  const worker = db.prepare(`SELECT ${jobFields} FROM lark_orchestration_jobs
    WHERE task_id=? AND kind='worker' AND state NOT IN ('accepted','superseded') ORDER BY rowid DESC LIMIT 1`)
    .get(task.id) as JobRow | undefined;
  const result = task.resultId ? db.prepare("SELECT id, result FROM lark_orchestration_jobs WHERE id=? AND task_id=? AND kind='worker'")
    .get(task.resultId, task.id) as { id: string; result: string | null } | undefined : undefined;
  const artifacts = result ? db.prepare(`SELECT rowid AS id, name, length(bytes) AS size, commit_id AS commitId
    FROM lark_orchestration_artifacts WHERE result_id=? ORDER BY rowid`).all(result.id) : [];
  const review = result && spec.reviewer ? db.prepare(`SELECT source, verdict, reason FROM (
      SELECT 'requester' AS source, a.verdict, a.reason, a.rowid AS sequence
      FROM lark_orchestration_acceptance a WHERE a.result_id=? AND ?='requester' AND
        (? IN ('accepted','changes_requested') OR a.verdict='inconclusive')
      UNION ALL
      SELECT 'engine', r.verdict, r.reason, j.rowid
      FROM lark_orchestration_reviews r JOIN lark_orchestration_jobs j ON j.id=r.job_id
      WHERE r.result_id=? AND j.task_id=? AND j.review_revision=? AND ?!='requester'
    ) ORDER BY sequence DESC LIMIT 1`)
    .get(result.id, spec.reviewer.engine, task.status, result.id, task.id, task.reviewRevision, spec.reviewer.engine) as
    { source: string; verdict: string; reason: string } | undefined : undefined;
  const reviewPending = Boolean(result && db.prepare(`SELECT 1 FROM lark_orchestration_jobs WHERE task_id=? AND kind='reviewer'
    AND parent_id=? AND review_revision=? AND state IN ('queued','submitted') LIMIT 1`).get(task.id, result.id, task.reviewRevision));
  // Result text keys are the worker/reviewer job ID or the requester review key; lifecycle notices are not delivery evidence.
  const delivery = result ? db.prepare(`SELECT o.id, o.state, o.receipt, o.attempted_at AS attemptedAt, o.artifact_name AS artifactName
    FROM lark_orchestration_outbox o WHERE o.task_id=? AND (o.artifact_id=? OR o.id=? OR
      (o.id LIKE 'request-review:%' AND substr(o.id,-36)=?) OR EXISTS (
        SELECT 1 FROM lark_orchestration_jobs j WHERE j.id=o.id AND j.task_id=o.task_id AND j.kind='reviewer' AND j.parent_id=?
        AND EXISTS (SELECT 1 FROM lark_orchestration_reviews r WHERE r.job_id=j.id))) ORDER BY o.rowid DESC LIMIT 50`)
    .all(task.id, result.id, result.id, result.id, result.id) : [];
  return { ...summary(task), goal: spec.goal,
    execution: worker ? { id: worker.id, state: worker.state, ...engineInfo.parse(JSON.parse(worker.route)) } : null,
    result: result ? { id: result.id,
      text: unicodeSafePrefix((result.result ?? "").replace(/^Result: (?:deliver|done|blocked)\r?\n/i, ""), 16_000), artifacts } : null,
    review: { required: Boolean(spec.reviewer), reviewer: spec.reviewer ?? null, pending: reviewPending || task.status === "awaiting_review" && !review,
      decision: review ? { source: review.source, verdict: review.verdict, reason: unicodeSafePrefix(review.reason, 3000) } : null },
    delivery };
}

export function registerTaskOrchestrationReadRoutes(app: FastifyInstance, db: Database.Database, authorized: (request: FastifyRequest) => boolean) {
  app.register(async routes => {
    routes.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authorized(request)) return reply.code(401).send({ error: "Runtime authorization required" });
    });
    routes.get("/v1/orchestration-tasks", async (request, reply) => {
      const parsed = listQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid task filters" });
      const { messageId, status, offset } = parsed.data;
      const filters = [...(messageId ? ["t.message_id=?"] : []), ...(status ? ["t.status=?"] : [])];
      const where = filters.length ? " WHERE " + filters.join(" AND ") : "";
      const params = [messageId, status].filter(value => value !== undefined);
      const items = db.prepare(`${taskFields}${where} ORDER BY t.rowid DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize + 1, offset) as TaskRow[];
      return { items: items.slice(0, pageSize).map(summary), hasMore: items.length > pageSize };
    });
    routes.get("/v1/orchestration-tasks/:taskId", async (request, reply) => {
      const parsed = detailParams.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid task ID" });
      const row = db.prepare(taskFields + " WHERE t.id=?").get(parsed.data.taskId) as TaskRow | undefined;
      if (!row) return reply.code(404).send({ error: "Task not found" });
      return detail(db, row);
    });
    routes.get("/v1/orchestration-tasks/:taskId/results/:resultId/files/:artifactId", async (request, reply) => {
      const parsed = fileParams.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid artifact identity" });
      const { taskId, resultId, artifactId } = parsed.data;
      const file = db.prepare(`SELECT a.name, a.bytes, a.checksum FROM lark_orchestration_artifacts a
        JOIN lark_orchestration_tasks t ON t.current_result=a.result_id
        JOIN lark_orchestration_jobs j ON j.id=a.result_id AND j.task_id=t.id AND j.kind='worker'
        WHERE t.id=? AND a.result_id=? AND a.rowid=? AND length(a.bytes)<=4194304`)
        .get(taskId, resultId, artifactId) as { name: string; bytes: Buffer; checksum: string } | undefined;
      if (!file || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(file.name)) return reply.code(404).send({ error: "File not found" });
      if (createHash("sha256").update(file.bytes).digest("hex") !== file.checksum)
        return reply.code(409).send({ error: "Frozen file checksum mismatch" });
      return reply.type("application/octet-stream").header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", `attachment; filename="${file.name}"`).send(file.bytes);
    });
  });
}
