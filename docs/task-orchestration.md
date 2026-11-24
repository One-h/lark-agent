# Delegated Tasks

The optional task-orchestration plugin adds an authenticated `lark_task_orchestration` tool to the existing Lark MCP catalog. Ordinary conversations keep their current route. Use the tool only when the user explicitly delegates a task or follows up on one.

## Pilot Setup

- Enable `LARK_AGENT_TASK_ORCHESTRATION=1` on the runtime and the separate engine host. Without it, the plugin is not mounted and no task tables or tools are installed. `LARK_AGENT_DISABLED_PLUGINS=task-orchestration` also disables the feature without removing data.
- Use the existing private engine-host socket, token and matching workspace. Configure `LARK_AGENT_ENGINE_HOST_ENGINES` on the runtime to include only the backend engines permitted for tasks. The host checks enabled engines, their models and the actual execution policy before launch.
- The host can open a dedicated Codex App Server process or connect to its own operator-specified `LARK_AGENT_TASK_CODEX_APP_SERVER_SOCKET`. Do not point it at the interactive runtime's socket. `LARK_AGENT_TASK_CODEX_MODELS` optionally lists allowed explicit model IDs; the server default works without a list. The four ACP engines use their existing operator-managed launchers.
- An enabled foreground route must already expose `lark_tools` with a live Lark turn context. A retained foreground ACP route that does not mount MCP cannot invoke this tool. The backend works in the host's configured workspace; it does not create or choose worktrees.
- Start in an isolated workspace and test conversation. The built-in pilot runs one task-engine invocation at a time. Codex's task adapter supports the trusted execution profile only. An ordinary request needs both the existing dispatch authorization and an engine with a restricted profile. A dispatch approval does not turn a restricted process into a trusted one; unsupported or restricted native elevation is not silently approved.

## Behavior

- **Dispatch:** specify the goal and a Worker engine, optionally a Reviewer engine or the requester. Existing trusted-session rules apply. Other callers go through task-level automatic review or manual approval before the Worker is queued. The full delegation is audited separately from a foreground turn grant.
- **Follow-up:** the original requester can supply input to the same Worker. Supported in-flight steering uses a stable input ID; otherwise it stays queued for the next turn in the same engine session. A disconnected call is not assumed to be unaccepted. Expansions require authorization before being added.
- **Finish and review:** the Worker decides whether to deliver a result, explain that no further work is needed, or report a blocker. A Reviewer judges a frozen text snapshot, which can contain immutable artifact references. It sends a plain-text verdict and rationale. A human verdict must identify the result version and come from the requester. The plugin does not determine business quality, create a cancellation workflow, or automatically schedule rework.
- **Recovery and posting:** the runtime reattaches by the original host generation and dispatch ID. An uncertain start or input is not replayed. A started reply without a receipt is checked by exact Feishu readback rather than resent. Group privacy and source identity are checked before dispatch and posting. Review state and delivery are separate.
