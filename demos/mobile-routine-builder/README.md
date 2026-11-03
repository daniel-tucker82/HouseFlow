# Mobile routine builder demo

Run `npm run demo:mobile` from the repository root, then open
http://127.0.0.1:4178 in Chrome. Open DevTools (`F12`) and toggle the device
toolbar (`Ctrl+Shift+M`). Try a 390 × 844 phone or a tablet preset.

The demo runs separately from Next.js and uses sample data only. It has no
authentication, database, API or deployment integration. Edits are saved in
localStorage under `cyntch-mobile-builder-demo-v1`; practice-run completions
are temporary. **Reset example** restores the sample; **Start from scratch**
creates an empty routine. Either action can be undone.

Try completing breakfast before getting dressed: brushing teeth becomes
available independently of the other branch. The reward waits for both
brushing teeth and packing the bag. Editing a task excludes any prerequisite
that would create a circular dependency.

Scheduling controls label the example routine; this demo does not execute
recurrence, send notifications or simulate date/time unlock rules.

The `.preview/` build output is local and ignored by Git.
