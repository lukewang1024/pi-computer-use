# Native input recovery on macOS

Foreground admission protects new input. Error cleanup has a different job: stop
the operation and balance only the key/button downs acquired by that transaction.
Cleanup uses the prepared up events, preserves unrelated modifiers, releases at
the current pointer position, and verifies both HID and combined-session state.
The application effect remains unknown and the interrupted action is never replayed.

The helper writes a private transaction journal before posting an input event and
acknowledges ownership after posting. Prepared events are explicitly distinguished
from acknowledged input. A helper exit or caller restart therefore retains the
evidence needed to inspect and recover input. Verified terminal journals have
bounded retention; pending journals are preserved.

For a quarantined managed desktop, run the packaged administrative command through
the original Controller. Close the task's own desktop consumer first, acquire the
native maintenance fence, and retain its exact owner. Do not displace another active
consumer. Use the actual Executor state file, not a client-created queue snapshot:

```sh
node scripts/recover-native-input.mjs --apply \
  --queue-file /absolute/executor/state/desktop-queue.json \
  --maintenance-owner OWNER --receipt /absolute/private/state/recovery.json
```

The command verifies the pinned signed helper, kernel boot identity, durable queue
epoch, maintenance owner, and absence of active/draining consumers. It reconciles
and stops only the exact managed helper processes, then inspects both OS input
tables. Recovery is up-only and limited to journaled input; it never sends a key
down, replays the interrupted action, stops a document application, changes Away
Guard, grants desktop access or writes the queue. Dead recovery locks retain their
abandoned intent and can be reclaimed only after process identity reconciliation.
Legacy owner-writable queue files can have their permissions hardened to owner-only
after admission verification; their queue contents are never rewritten by this command.

An older helper may have left no journal. An operator explicitly authorized to
repair that incident can select its observed residual codes with `--scoped-reset`,
`--keys`, `--mouse-buttons` and a specific `--reason`. This is recorded as a scoped
reset, not retroactive input ownership. Unknown input outside that exact scope
refuses recovery before any release. There is no all-keys default. `--inspect`
performs read-only diagnosis without stopping a helper or sending input.

A verified receipt requires the old helpers stopped, zero down events, only allowed
up events, two consecutive neutral native samples and an independent final probe.
The queue stays quarantined throughout. Once that actual desktop reset is verified,
the caller may use the original Controller's `desktop.recover` and release its own
maintenance fence. Fresh desktop availability/operator consent and fresh observation
references are still required for subsequent application input. No human statement
that keys have been released is required when the native receipt proves recovery.

A blocked, incomplete or transport-unknown receipt is not recovery proof. Inspect
the persisted intent and current system state; never repeat the interrupted action
or clear quarantine merely because a process restarted.
