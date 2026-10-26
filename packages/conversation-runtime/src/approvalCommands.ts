import path from "node:path";
import { parse, type ParseEntry } from "shell-quote";

type Tool = "git" | "kubectl" | "argocd";

const valueOptions: Record<Tool, ReadonlySet<string>> = {
  git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--exec-path"]),
  kubectl: new Set(["--context", "--kubeconfig", "--namespace", "-n", "--cluster", "--user", "--server", "-s", "--request-timeout", "--token", "--certificate-authority", "--client-certificate", "--client-key", "--as", "--as-group", "--as-uid", "--cache-dir", "--tls-server-name", "-v", "--v", "--vmodule"]),
  argocd: new Set(["--server", "--auth-token", "--config", "--context", "--kube-context", "--namespace", "--header", "-H", "--loglevel", "--logformat", "--port-forward-namespace", "--grpc-web-root-path"])
};
const booleanOptions: Record<Tool, ReadonlySet<string>> = {
  git: new Set(["--no-pager", "--paginate", "--bare", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-replace-objects", "--no-lazy-fetch", "--no-advice"]),
  kubectl: new Set(["--insecure-skip-tls-verify", "--warnings-as-errors", "--disable-compression", "--match-server-version"]),
  argocd: new Set(["--core", "--grpc-web", "--insecure", "--plaintext", "--port-forward", "--prompts-enabled"])
};

function word(token: ParseEntry | undefined): string | null {
  return typeof token === "string" ? token.replace(/[\r\n]/g, "") : null;
}

function commandIndex(tokens: ParseEntry[], start: number, tool: Tool): number | null {
  for (let index = start; index < tokens.length; index++) {
    const token = word(tokens[index]);
    if (token === null) return null;
    if (token === "--") return typeof tokens[index + 1] === "string" ? index + 1 : null;
    if (!token.startsWith("-")) return token.includes("$") ? null : index;
    const option = token.split("=", 1)[0];
    if (valueOptions[tool].has(option)) {
      if (!token.includes("=")) {
        if (typeof tokens[++index] !== "string") return null;
      }
    } else if (booleanOptions[tool].has(option)) {
      continue;
    } else if ((tool === "git" && /^-[Cc].+/.test(token))
      || (tool === "kubectl" && /^-[nsv].+/.test(token))
      || (tool === "argocd" && /^-H.+/.test(token))) {
      continue;
    } else {
      // Unknown global option arity cannot safely identify the subcommand.
      return null;
    }
  }
  return null;
}

export function requiresManualCliApproval(operation: string, depth = 0): boolean {
  // Ambiguous line continuations are never eligible for an automatic grant.
  if (depth > 4 || operation.length > 32_768 || /\\\r?\n/.test(operation)) return true;
  let tokens: ParseEntry[];
  try {
    tokens = parse(operation, (name) => `$${name}`);
  } catch { return true; }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (typeof token !== "string") {
      // shell-quote treats the remainder after # as a comment, including later lines.
      if ("comment" in token) {
        const newline = /\r?\n/.exec(token.comment);
        if (newline && requiresManualCliApproval(token.comment.slice(newline.index + newline[0].length), depth + 1)) return true;
      }
      continue;
    }
    const executable = path.basename(word(token)!);
    if (["sh", "bash", "zsh", "dash", "fish"].includes(executable)) {
      for (let argument = index + 1; argument < tokens.length; argument++) {
        const flag = word(tokens[argument]);
        if (flag === null) break;
        if (/^-[^-]*c/.test(flag) || flag === "--command") {
          const script = tokens[argument + 1];
          if (typeof script !== "string" || requiresManualCliApproval(script, depth + 1)) return true;
          break;
        }
        if (flag.startsWith("--command=")) {
          if (requiresManualCliApproval(flag.slice("--command=".length), depth + 1)) return true;
          break;
        }
      }
    }
    if (!["git", "kubectl", "argocd"].includes(executable)) continue;
    const tool = executable as Tool;
    const verbIndex = commandIndex(tokens, index + 1, tool);
    if (verbIndex === null) return true;
    const verb = word(tokens[verbIndex]);
    if (tool === "git" && ["push", "merge", "reset", "clean"].includes(String(verb))) return true;
    if (tool === "kubectl" && ["delete", "edit"].includes(String(verb))) return true;
    if (tool === "argocd" && verb === "app" && word(tokens[verbIndex + 1]) === "delete") return true;
  }
  return false;
}
