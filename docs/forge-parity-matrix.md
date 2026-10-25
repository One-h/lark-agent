# Forge Feishu Parity Matrix

This is the implementation contract for the migration from Agent Forge. Do not
declare the migration complete until every row is implemented and verified under
the standalone runtime.

| Area | Forge source behavior | Lark Agent target | Verification | Status |
| --- | --- | --- | --- | --- |
| Listener | `larkWorker.ts`: one message and one card listener, restart management, bot open-id lookup | `conversation-runtime/worker` owns message and approval listeners | worker tests and real bot event | done |
| Intake | event persistence, exactly-once by event/message ID, mention filtering, P2P handling | migrated `lark_messages` is authoritative | duplicate constraints and real bot event | done |
| Group rounds | exact bot mention, optional spontaneous participation, cooldown, human/bot round rules | conversation runtime policy and cooldown query | deterministic policy tests and real group mention | done |
| Sessions | P2P/group + trust scope, active turn steer, persisted session ID | conversation runtime session keys, resume and active `turn/steer` | ownership test and real two-message steer | done |
| Context | newest bounded group messages, quoted content, referenced images/files, relevant contacts only | same bounded projection and attachment resolver | prompt fixtures plus real group/image/Markdown checks | done |
| Trust | persisted trusted senders, approval recipient, sender reply profiles | runtime settings and persistent profiles | settings round-trip and restart test | done |
| Prompt | assistant override, skills/workspace guidance, no untrusted internal leakage | conversation runtime prompt builder and configurable prompts | trusted/untrusted behavior tests | done |
| Reply | reply-to semantics, real group @ mention, no-reply outcome, idempotency | Lark adapter transport and conversation runtime formatting | tests and real group reply readback | done |
| Reactions | configurable acknowledgement emoji | configurable reaction before turn | live event and mock transport | done |
| Streaming | one bounded interim update for humans, none for bot senders, final complete response | migrated responder stream ownership and delivery | migrated stream fixture and real final reply | done |
| Attachments | current and quoted images/files, Markdown/HTML extraction, safe paths | attachment resolver and artifact records | image/file/quote tests and real image/Markdown readback | done |
| Media | file output, grouped multi-image post, safe output directory | grouped image delivery and durable media outbox | media tests, real two-image post and sent outbox row | done |
| Stickers | query ranking, recent avoidance, usage records, ID/query declaration | conversation runtime sticker module backed by standalone SQLite | ranking, staging and lifecycle tests | done |
| Contacts | mention ingestion, aliases, CLI sync, send-target lookup | conversation runtime contact module backed by standalone SQLite | sync parsing and alias tests | done |
| Approval | normalize all App Server requests, batch card, approve-once/turn, card terminal patch, requester outcome | App Server approvals plus Dynamic Tool capability approvals | protocol/security tests and real card terminal readback | done |
| Recovery | startup/orphan detection, auth/cwd recovery, retryable state, no replay of writes | migrated recovery decisions and responder state machine | tests plus interrupted-turn restart acceptance | done |
| Observability | task artifacts, stderr/stdout, event timeline and delivery attempts | durable task artifacts, status events and media outbox | detail/events API and console proxy checks | done |
| Console | messages, artifacts, contacts, stickers, settings proxy | Forge proxy reads/writes standalone API only | full-history search, filters, detail and page smoke checks | done |

## Acceptance Evidence

- Host Dynamic Tool: Feishu message `3913` called `forge.todo.create` and created Forge todo `63`.
- Active-turn steering: two consecutive P2P messages shared one thread and one turn; the later message owned the final reply.
- Group context and mention: messages `3914` and `3915` produced `PARITY-GROUP-830`; Feishu readback showed a real mention of the triggering sender.
- Image and media: message `3917` downloaded the quoted image and sent two images in one `post` message.
- Markdown attachment: message `3920` downloaded quoted `README.md` and answered `Lark Agent`.
- Approval: capability approval `1` sent a real card, changed it to `已允许当前任务`, and created Forge todo `64` only after approval.
- Recovery: running message `3922` was marked failed on runtime restart; message `3923` then completed with `RECOVERY-PARITY-OK` without replaying the interrupted command.
- Standalone ownership: with Forge stopped, message `3926` still completed with `STANDALONE-PARITY-OK`.
- Durable media delivery: message `3928` completed with a `sent` `lark_delivery_outbox` row and the runtime remained healthy.

## Maintenance Rule

The direct Forge migration is complete and remains available through Git history.
New behavior belongs in `conversation-runtime`, transport code belongs in the
corresponding adapter, and private business operations remain registered host
capabilities. Do not reintroduce a migration-only runtime package.
