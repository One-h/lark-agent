# Markdown Replies and Data Cards

Codex final replies are rendered by the service, without asking the model to generate card JSON or making another model call:

- Explanations, ordinary lists and code use a `post` message with an `md` element.
- Top-level GFM tables use Card 2.0 native table components. Repeated record lists with structured fields or nested field lists use grouped card content. Ambiguous prose lists remain Markdown.
- Large results use an explicitly bounded preview and a complete UTF-8 Markdown attachment. Current table previews show at most 20 rows and 8 columns, record previews at most 12 items; these are presentation limits, not query or result-coverage limits.
- Existing progress cards, approval cards, execution receipts, proactive messaging and user-identity inbox replies keep their existing behavior.

The renderer uses a Markdown parser, so fenced code containing table syntax remains code. Original Markdown and literal numeric strings are retained; values are not recomputed or coerced. Sender mentions are separated from the first Markdown block and use the platform syntax appropriate to `post` or cards. No remote image is downloaded by the renderer; images and stickers continue through the attachment tools.

## Delivery and History

New final replies persist a versioned `reply_delivery_payload` snapshot beside the original `reply_delivery_text`. Retries and restarts use the same snapshot and idempotency key. Legacy pending messages without a snapshot retain their literal text transport. A missing delivery receipt or invalid snapshot is not marked as successful.

Overflow attachments are content-addressed, integrity-checked files in the task output directory. Their outbox rows and the presentation snapshot are committed together before sending. Attachments wait for the final reply receipt, and completion reactions wait for attachment delivery. Failed delivery does not silently switch message types or send a second fallback message with a new key.

Outbound history stores the real platform message type and readable original Markdown, not the card JSON. The raw presentation remains available with the source message delivery snapshot. This keeps downstream conversation context and the existing console readable.

Card payloads are bounded conservatively; content that cannot fit a valid card is prepared as a Markdown preview plus the complete attachment before any network send. Platform transport failures use the existing retry policy rather than guessing whether a second message is safe.

## Upgrade

Use Node 24 and install the lockfile dependencies. Normal startup adds the nullable snapshot column to existing databases; no data reset or historical-message replay is needed. Wait for all work and deliveries to become idle before restarting the managed runtime. Test only through `npm test`, which uses isolated temporary databases.
