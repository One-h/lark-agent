import { parse } from "shell-quote";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { ApprovalPlan } from "./approvalPlan.js";
import { planCoversOperation } from "./approvalPlan.js";
import type { TurnApprovalInput } from "./turnAutoApproval.js";

function argv(command: string): string[] | undefined {
  if (/[\r\n$\x60]/.test(command)) return;
  try {
    const tokens = parse(command);
    return tokens.every((token): token is string => typeof token === "string") ? tokens : undefined;
  } catch { return; }
}

function duration(value: string | undefined): boolean {
  return Boolean(value && /^\d{1,2}[smh]$/.test(value) && (!value.endsWith("h") || Number(value.slice(0, -1)) <= 24));
}

function observabilityScope(args: string[], cwd: string | null): string | undefined {
  if (!cwd || !path.isAbsolute(cwd) || args[0] !== "python3" || !args[1]) return;
  let managed: string;
  try {
    managed = realpathSync(path.join(cwd, ".agents/skills/grafana-observability/scripts/grafana_observe.py"));
    if (realpathSync(path.resolve(cwd, args[1])) !== managed) return;
  } catch { return; }
  const offset = args[2] === "--insecure" ? 3 : 2;
  const mode = args[offset];
  if (mode !== "logs" && mode !== "prom") return;
  const flags = new Map<string, string>();
  for (let i = offset + 1; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!value || value.startsWith("--") || flags.has(name)
      || !(mode === "logs" ? ["--uid", "--query", "--since", "--limit", "--max-line-chars"] : ["--uid", "--query"]).includes(name)) return;
    flags.set(name, value);
  }
  const query = flags.get("--query");
  if (!query) return;
  const source = ["managed-observability", managed, offset === 3, mode, flags.get("--uid") ?? null];
  if (mode === "prom") {
    // Preserve all selectors and expressions, varying only ordinary time windows.
    return JSON.stringify([...source,
      query.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[\d{1,2}[sm]\]/g, token => token.startsWith("[") ? "[range]" : token)]);
  }
  const uid = flags.get("--uid"), limit = flags.get("--limit"), chars = flags.get("--max-line-chars");
  if (!uid || !/^[A-Za-z0-9_-]{1,64}$/.test(uid) || !limit || !/^\d{1,3}$/.test(limit) || +limit < 1 || +limit > 100
    || !duration(flags.get("--since")) || (chars !== undefined && (!/^\d{1,4}$/.test(chars) || +chars < 1 || +chars > 2000))) return;
  // A single stream selector followed only by literal line filters. Preserve
  // every selector, not just the first namespace or service mentioned.
  const match = /^\s*\{([^{}]+)\}\s*((?:(?:\|=|\|~|!=|!~)\s*"(?:\\.|[^"\\])*"\s*)*)$/.exec(query);
  if (!match) return;
  const selectors = new Map<string, string>();
  for (const token of match[1].split(",")) {
    const label = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([A-Za-z0-9_.-]{1,120})"\s*$/.exec(token);
    if (!label || selectors.has(label[1])) return;
    selectors.set(label[1], label[2]);
  }
  if (!selectors.get("namespace") || !["app", "app_kubernetes_io_name", "service_name"].some(key => selectors.has(key))) return;
  return JSON.stringify([...source, [...selectors].sort()]);
}

function readScope(command: string, cwd: string | null): string | undefined {
  let args = argv(command);
  if (!args) return;
  if (args.length === 3 && /^\/(?:usr\/)?bin\/(?:ba|z|da)?sh$/.test(args[0]) && ["-c", "-lc"].includes(args[1]))
    args = argv(args[2]);
  if (!args) return;
  if (args[0] === "python3") return observabilityScope(args, cwd);
  // Vary only bounded output controls; the executable, flags controlling the
  // destination, resource, namespace and selectors remain part of the key.
  const tool = args[0];
  if (tool !== "kubectl" || args[1] !== "logs" || args.length < 3) return;
  const scope = args.slice(0, 2);
  let bounded = false;
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (flag.startsWith("--tail=") || flag === "--tail") {
      const value = flag === "--tail" ? args[++i] : flag.slice(7);
      if (!value || !/^\d{1,4}$/.test(value) || Number(value) > 1000) return;
      bounded = true;
    } else if (flag.startsWith("--since=") || flag === "--since") {
      const value = flag === "--since" ? args[++i] : flag.slice(8);
      if (!duration(value)) return;
    } else {
      if (/^--(?:follow|all-namespaces|insecure-skip-tls-verify|server|token|as(?:-group|-uid)?)(?:=|$)/.test(flag) || /^-[fAs]$/.test(flag)) return;
      scope.push(flag);
    }
  }
  return bounded && scope.length > 2 ? JSON.stringify(scope) : undefined;
}

export function hasWholeTurnReadScope(input: TurnApprovalInput): boolean {
  return input.operationKind === "command" && readScope(input.operation, input.cwd) !== undefined;
}

export function wholeTurnPlanCovers(plan: ApprovalPlan, input: TurnApprovalInput): boolean {
  if (planCoversOperation(plan, input)) return true;
  if (input.operationKind !== "command") return false;
  const key = readScope(input.operation, input.cwd);
  return key !== undefined && plan.steps.some(step => step.effect === "read" && step.kind === "command"
    && step.cwd === input.cwd && readScope(step.operation, step.cwd) === key);
}

/** An intent is not a permission to run unrecognized shell commands. The
 * precise declared steps remain usable if no semantic matcher is available. */
export function wholeTurnScope(first: TurnApprovalInput, plan?: ApprovalPlan, readOnlyTask = false): (candidate: TurnApprovalInput) => boolean {
  const initial = { operation: first.operation, cwd: first.cwd, kind: first.operationKind };
  const reads = [initial, ...(plan?.steps.filter(step => step.effect === "read") ?? [])]
    .flatMap(step => step.kind === "command" ? [{ key: readScope(step.operation, step.cwd), cwd: step.cwd }] : [])
    .filter(step => step.key !== undefined);
  return candidate => {
    if (candidate.messageId !== first.messageId || candidate.senderId !== first.senderId || candidate.turnId !== first.turnId
      || candidate.originalMessage !== first.originalMessage || !candidate.operationKind) return false;
    if (readOnlyTask && (/forge\.deploy\.production:|--execute|\bargocd\b.*\bapp\s+sync\b|\bkubectl\b.*\b(?:apply|patch|delete|edit|scale|rollout\s+restart)\b/i.test(candidate.operation)
      || plan?.steps.some(step => step.effect === "remote-write" && planCoversOperation({ ...plan, steps: [step] }, candidate)))) return false;
    if (candidate.operationKind === initial.kind && candidate.operation === initial.operation && candidate.cwd === initial.cwd) return true;
    if (plan && planCoversOperation(plan, candidate)) return true;
    if (candidate.operationKind !== "command") return false;
    const key = readScope(candidate.operation, candidate.cwd);
    return key !== undefined && reads.some(step => step.key === key && step.cwd === candidate.cwd);
  };
}
