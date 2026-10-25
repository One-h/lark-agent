import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ResolveCodexExecutableOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  bundledExecutable?: string;
};

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function expandHome(filePath: string, homeDir: string): string {
  if (filePath === "~") return homeDir;
  if (filePath.startsWith("~/")) return path.join(homeDir, filePath.slice(2));
  return filePath;
}

function executableFromPath(command: string, pathValue: string): string | null {
  for (const directory of pathValue.split(path.delimiter).map((value) => value.trim()).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveCodexExecutable(options: ResolveCodexExecutableOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const configured = env.CODEX_EXECUTABLE?.trim();

  if (configured) {
    const expanded = expandHome(configured, homeDir);
    const resolved = expanded.includes(path.sep)
      ? path.resolve(expanded)
      : executableFromPath(expanded, env.PATH ?? "");
    if (resolved && isExecutable(resolved)) return resolved;
    throw new Error(`Configured Codex executable is not available: ${configured}`);
  }

  const pathExecutable = executableFromPath("codex", env.PATH ?? "");
  if (pathExecutable) return pathExecutable;

  const fallbacks = [
    path.join(homeDir, ".local", "bin", "codex"),
    options.bundledExecutable ?? "/Applications/ChatGPT.app/Contents/Resources/codex"
  ];
  const fallback = fallbacks.find(isExecutable);
  if (fallback) return fallback;

  throw new Error("Codex executable not found. Install Codex or set CODEX_EXECUTABLE to its absolute path.");
}
