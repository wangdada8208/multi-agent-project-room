# PostgreSQL task wakeups and bounded Hub reconciliation

Status: approved by the user on 2026-10-11; implementation and isolated acceptance in progress.

TaskEvent insertion calls pg_wakeup.signal_in_transaction in the caller's transaction
with a versioned room identifier hint (mapr_wakeup_v1, v=1/kind=room/id).
TaskReconciler owns one PgWakeup, and has no separate LISTEN implementation.
Each worker owns one independent autocommit LISTEN connection. LISTEN is established
before a fresh database scan; reconnect always schedules another scan. Notifications
are hints, never task data, authority, or a commit-order cursor. SQLite uses polling.

Each authenticated local WebSocket is registered independently of presence/identify.
A bounded sequential worker cycles UUID keyset pages and resets at the end of every
pass. Inserts and reverse commits behind the cursor are discovered on the next pass.
Legacy task_resume cursors remain one-pass pagination only; they are not an incremental
high-water mark. The worker never calls task_resume or increments dispatch attempts.
Persisted offers are replayed with the same attempt. ACK and execution fencing remain
transactional. No exactly-once claim is made.

Room clients receive authorized task state snapshots and latest persisted progress;
explicit task_events/SSE cursors remain the lossless historical replay interface.
Public chat/presence broadcasts remain local to a worker. No chat body, result body,
credential, or progress text goes into NOTIFY. Periodic polling survives listener loss.

No schema change is required. Existing migrations through d40 remain untouched.

Clarification: the periodic scan is read-only. An unoffered or expired pending offer
may enter a separate transactional dispatch repair, locking the parent and checking
state, attempt and original offer deadline. This can increment attempt at most once
per 60-second offer window across workers; active offers are replayed unchanged.
ACKed work is never restarted: expiry remains uncertain for human review.

The bounded keyset pass captures its UUID upper bound; fresh discovery always
starts another pass from empty. The explicit `snap1:` resume token includes agent,
after and upper bounds, while old bare UUID continuation is accepted. This is a
bounded, weakly consistent pagination pass, not a PostgreSQL MVCC snapshot or a
commit-order watermark. Late commits behind the cursor are found on a later pass.
Cyclic discovery assumes admitted workload remains within scan capacity; no fixed
latency bound is promised under overload or indefinite database unavailability.

Integration uses the existing PgWakeup API exclusively. Its periodic catchup and
LISTEN recovery call the same serialized bounded scan; hints wake the jittered scan
worker. Client reconnect also wakes this worker. No second channel/listener exists.

Revocation boundary: current permissions gate task bodies, ACK acquisition, leases,
progress and results. A canceled task can still send an identifier-only stop frame
to the delivery's authenticated Agent account. Its original lease-owning connection
can attest cleanup despite room revocation; a different connection is still fenced.
This exception grants neither data access nor execution and is covered on real PG
with the executor connected to the other Hub.

Final isolated acceptance: backend/client SQLite gate 522 passed, 16 PG-only skipped,
5 existing WebSocket deprecation warnings; PG17 gate 40 passed, no pytest warnings;
frontend 45 passed and production build passed. PG tests include 12 real dual-Hub
cases and 28 reconciliation cases. Exact commands, cleanup and limits are recorded
in /tmp/mapr-pg-reconcile/REPORT.md (temporary local artifact, not deployment proof).
