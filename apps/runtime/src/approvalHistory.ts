import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SqliteAgentStore } from "@lark-agent/adapter-sqlite";

// Automatic turn decisions are distinct from the individual operations they authorize.
const records = `
  SELECT id, 'auto' AS kind, lark_message_id AS messageId, source, decision AS status,
    reason, requester_id AS requesterId, approver_id AS approverId, task_type AS taskType,
    target, model, matched_approval_id AS matchedApprovalId, applied_at AS appliedAt,
    created_at AS createdAt, completed_at AS completedAt, 'turn' AS scope
  FROM lark_turn_auto_reviews
  UNION ALL
  SELECT a.id, 'execution', a.lark_message_id, 'manual', a.status, a.reason,
    a.requester_id, a.approver_id, NULL, NULL, NULL, NULL, NULL,
    a.created_at, a.decided_at, a.approval_scope
  FROM lark_execution_approvals a
  WHERE a.card_message_id IS NOT NULL OR a.status IN ('pending','failed','rejected','expired')
  UNION ALL
  SELECT a.id, 'capability', a.lark_message_id, 'manual', a.status, NULL,
    m.sender_id, a.approver_id, NULL, a.capability_id, NULL, NULL, NULL,
    a.created_at, a.decided_at, 'once'
  FROM lark_capability_approvals a LEFT JOIN lark_messages m ON m.id=a.lark_message_id
`;
const joins = `LEFT JOIN lark_messages m ON m.id=r.messageId
  LEFT JOIN lark_contacts requester ON requester.open_id=r.requesterId
  LEFT JOIN lark_contacts approver ON approver.open_id=r.approverId`;
const listColumns = `r.*, requester.name AS requesterName, approver.name AS approverName,
  substr(m.content,1,280) AS requestPreview`;

function details(store: SqliteAgentStore, kind: string, id: number, includeMatch = true): Record<string, unknown> | undefined {
  const select = kind === "auto"
    ? `SELECT id,'auto' AS kind,lark_message_id AS messageId,source,decision AS status,reason,
        requester_id AS requesterId,approver_id AS approverId,task_type AS taskType,target,model,
        matched_approval_id AS matchedApprovalId,applied_at AS appliedAt,created_at AS createdAt,
        completed_at AS completedAt,'turn' AS scope,cwd,turn_id AS turnId,usage_json AS usageJson,
        NULL AS error,(SELECT operation FROM lark_execution_approvals a WHERE a.turn_id=r.turn_id
          AND a.requester_id=r.requester_id ORDER BY a.id LIMIT 1) AS operation
       FROM lark_turn_auto_reviews r WHERE id=?`
    : kind === "execution"
    ? `SELECT id,'execution' AS kind,lark_message_id AS messageId,'manual' AS source,status,reason,
        requester_id AS requesterId,approver_id AS approverId,NULL AS taskType,NULL AS target,NULL AS model,
        NULL AS matchedApprovalId,NULL AS appliedAt,created_at AS createdAt,decided_at AS completedAt,
        approval_scope AS scope,cwd,turn_id AS turnId,NULL AS usageJson,card_error AS error,operation
       FROM lark_execution_approvals WHERE id=?`
    : `SELECT a.id,'capability' AS kind,a.lark_message_id AS messageId,'manual' AS source,a.status,NULL AS reason,
        m.sender_id AS requesterId,a.approver_id AS approverId,NULL AS taskType,a.capability_id AS target,NULL AS model,
        NULL AS matchedApprovalId,NULL AS appliedAt,a.created_at AS createdAt,a.decided_at AS completedAt,
        'once' AS scope,NULL AS cwd,a.turn_id AS turnId,NULL AS usageJson,NULL AS error,a.operation
       FROM lark_capability_approvals a LEFT JOIN lark_messages m ON m.id=a.lark_message_id WHERE a.id=?`;
  const row = store.db.prepare(`SELECT ${listColumns},m.content AS request,m.codex_session_id AS sessionId
    FROM (${select}) r ${joins}`).get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  let usage: unknown = null;
  try { usage = row.usageJson ? JSON.parse(String(row.usageJson)) : null; } catch { /* Legacy malformed usage remains unavailable. */ }
  const { usageJson: _usageJson, ...safe } = row;
  return { ...safe, usage, matchedApproval: includeMatch && row.matchedApprovalId
    ? details(store, "execution", Number(row.matchedApprovalId), false) ?? null : null };
}

export function registerApprovalHistoryRoutes(app: FastifyInstance, store: SqliteAgentStore, authenticated: (request: FastifyRequest) => boolean) {
  app.get("/v1/approval-history", async (request, reply) => {
    if (!authenticated(request)) return reply.code(401).send({ error: "unauthorized" });
    const query = request.query as Record<string, unknown>;
    const kind = query.kind ?? "auto";
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    const sources = ["history", "model", "manual"];
    const statuses = ["approved", "manual", "reviewing", "pending", "rejected", "expired", "failed"];
    if (!["auto", "manual", "all"].includes(String(kind)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000
      || (query.source !== undefined && !sources.includes(String(query.source)))
      || (query.status !== undefined && !statuses.includes(String(query.status)))
      || (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 200))) {
      return reply.code(400).send({ error: "invalid approval history filters" });
    }
    const where = [kind === "auto" ? "r.kind='auto'" : kind === "manual" ? "r.kind<>'auto'" : "1=1"];
    const args: Array<string | number> = [];
    if (query.source !== undefined) { where.push("r.source=?"); args.push(String(query.source)); }
    if (query.status !== undefined) { where.push("r.status=?"); args.push(String(query.status)); }
    const q = String(query.q ?? "").trim();
    if (q) {
      where.push(`(instr(lower(COALESCE(m.content,'') || ' ' || COALESCE(requester.name,'') || ' ' || COALESCE(r.target,'')
        || ' ' || COALESCE(r.requesterId,'') || ' ' || r.messageId || ' ' || r.id || ' ' || COALESCE(r.model,'') || ' ' || COALESCE(r.reason,'')),lower(?))>0)`);
      args.push(q);
    }
    const from = `FROM (${records}) r ${joins} WHERE ${where.join(" AND ")}`;
    const total = (store.db.prepare(`SELECT count(*) AS total ${from}`).get(...args) as { total: number }).total;
    const items = store.db.prepare(`SELECT ${listColumns} ${from} ORDER BY r.createdAt DESC,r.id DESC,r.kind LIMIT ? OFFSET ?`).all(...args,limit,offset);
    const summary = store.db.prepare(`SELECT
      COALESCE(sum(kind='auto' AND source='history' AND status='approved'),0) AS historyApproved,
      COALESCE(sum(kind='auto' AND source='model' AND status='approved'),0) AS modelApproved,
      COALESCE(sum(kind='auto' AND status='manual'),0) AS manualRequired,
      COALESCE(sum(kind<>'auto' AND status='pending'),0) AS pendingHuman
      FROM (${records})`).get();
    return { items, total, limit, offset, summary };
  });
  app.get("/v1/approval-history/:kind/:id", async (request, reply) => {
    if (!authenticated(request)) return reply.code(401).send({ error: "unauthorized" });
    const { kind, id } = request.params as { kind: string; id: string };
    if (!["auto", "execution", "capability"].includes(kind) || !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) {
      return reply.code(400).send({ error: "invalid approval history id" });
    }
    const row = details(store, kind, Number(id));
    return row ?? reply.code(404).send({ error: "approval history not found" });
  });
}
