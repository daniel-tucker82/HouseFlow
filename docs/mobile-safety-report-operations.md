# Private safety-report review

This feature is implemented behind `SAFETY_REPORTS_ENABLED=true`. Keep that flag
off until a named operator has private database access, a working review routine,
and a verified way to act on harmful household content or account misuse. A
stored report is evidence of receipt, not evidence that someone has reviewed it.
No email, push to support staff, or automated moderation decision is sent.

The native Settings form accepts content and member concerns from every signed-in
household role. Kiosk mode remains task-only. Account-scoped SQLite saves drafts
and freezes submitted reports before transmission. Foreground/network events
retry the same operation ID; receipt persistence removes the local report text.
There is no polling timer and no extra work on the task-completion save path.
The API exposes only availability and the reporter's own acknowledgement. It
does not expose a household report list, and sends no household notification.

## Operator commands

Use a private terminal with the repository's dependencies installed. Set
`SAFETY_REVIEW_DATABASE_URL` explicitly to an authorised database credential and
`SAFETY_REVIEWER_ID` to the operator's identifier. The tool never loads `.env`
files or chooses a production database automatically. Do not record credentials
or report text in chat, shared logs, tickets or CI artifacts.

```text
node scripts/review-safety-reports.cjs list
node scripts/review-safety-reports.cjs show <report-uuid>
node scripts/review-safety-reports.cjs reviewing <report-uuid> <revision> <private-note-file>
node scripts/review-safety-reports.cjs resolved <report-uuid> <revision> <private-note-file>
node scripts/review-safety-reports.cjs redacted <report-uuid> <revision>
```

`list` shows the oldest 50 unresolved reports without their text or account IDs.
`show` reads one report for investigation. Notes come from a private file rather
than shell arguments/history. Read the current revision before each update;
stale changes fail and every accepted transition records the reviewer and time.
Start review before resolving. Record the actual investigation/action in the
resolution note; a state change does not itself remove content or block an
account. Never claim action that has not been performed and verified. Use the
existing authorised administrative process to remove harmful content or restrict
access, preserve unrelated household data, then verify the affected views.

Check the inbox regularly and define coverage/escalation before enabling public
submissions. Resolve urgent concerns promptly. During release verification use
only clearly marked disposable fixture content; do not send real user reports.

## Retention and deletion

Household deletion preserves concerns awaiting review. Account deletion removes
reports authored by that account and their review audit through foreign keys.
Other reporters' concerns are not silently erased when a mentioned person leaves.
Handle requests concerning those details through the privacy/support process.

Review resolved reports for redaction after 90 days. The `redacted` action is
available only after that interval and removes subject, message and resolution
note together. It keeps receipt metadata, payload hash and the text-free review
audit, so a delayed client retry cannot recreate the report or lose its receipt.
Redacted reports cannot be reopened. This command is manual; no retention job or
staffed support service has been configured in production by this change.

## Release checks still required

- Run the native form on Android and iPhone: draft interruption/restart,
  offline submit/reconnect, successful receipt, rejected household access,
  large text, rotation and screen-reader labels.
- Verify the real operational inbox and an actual, reversible moderation action
  using a disposable household. Confirm who monitors it and when.
- Publish the accurate privacy/terms pages and record terms acceptance before
  shared content creation. Policy links alone do not record acceptance.
- Resolve the IARC private-household classification/age-rating gap truthfully;
  do not mark reporting as available in the store until enabled and verified.
