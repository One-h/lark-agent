# Owner-only ordinary direct messages

`ownerMessageFastPathEnabled` defaults to false. Enabling it through authenticated
`PATCH /v1/settings` pins `ownerMessageFastPathOwnerId` to the current approver.
Disable the same setting to restore approval for all outbound messages. Changing
the approver alone never transfers the exemption to another person.

Only `lark.message.send` can use this exemption. All of these must hold:

- A running turn originates from the pinned owner in a private, plain-text user
  message. The turn ID must match the persisted source message.
- The entire source is a direct command such as `跟示例同事说：你好` or
  `给示例同事发消息：test`, with one explicit recipient and literal message text.
- That recipient resolves uniquely to an active, internal cached contact. Exact
  names, aliases and open IDs must all belong to that same contact.
- The outgoing text exactly matches the source, is at most 100 characters, and
  matches a conservative ordinary-message allowlist. Initially this covers
  short greetings/acknowledgements, simple time notifications and gift-origin
  phrases. Sensitive terms and unsupported free-form content retain approval.

This is intentionally not a claim to classify arbitrary sensitive prose. No
extra model review, broad trusted-user grant, user-identity send, API permission
change or external-user exception is introduced. Quoted/forwarded directives,
group requests, multi-recipient requests, non-owner requests, inactive/external
or duplicate contacts, edited message bodies and stale turns keep the existing
human approval flow. Other capabilities are unchanged.

Successful invocations retain the normal platform receipt and add
`_authorization.mode=explicit-owner-message` and `policyVersion=1` to their stored
result. They do not fabricate a human approval record. Existing invocation
deduplication prevents a repeated tool call from sending twice.

Regression tests use fresh OS-temporary databases and mocked senders only. Live
rollout checks settings/readiness without sending a message or retrying history.
