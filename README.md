# PingRoom critical-path planning

Collect duration estimates from one named planner, then calculate the critical
paths through a fixed task dependency graph. PingRoom asks about each task's
elapsed minutes; code calculates relative earliest/latest times, slack, and the
project duration. A complete plan requires a numeric estimate for every task.

This is a planning proposal. It does not assign people, start tasks, book calendar
time, or promise a completion date.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux with private persistent storage.
Choose **Use this template**, clone your repository, then run:

```sh
npm ci
npm test
npm run demo
```

The demo plans a community guide: after drafting, illustration and proofreading
can proceed in parallel; packaging waits for both. A second run demonstrates an
Unknown estimate blocking the plan. The demo uses the real SDK with an in-memory
HTTP transport, needs no credentials, makes no network requests, and removes its
temporary state. Installation requires npm access.

## Prepare and connect

```sh
cp examples/plan.json plan.json
cp config.example.json config.json
npm run graph
npm run connect
npm run inspect
```

Edit `plan.json` with a unique `planId`, a title, and 1–12 tasks. Each task has a
unique `id`, `label`, `details`, `dependsOn` array, and 2–3 increasing integer
`minutes` choices between 1 and 480:

```json
{
  "id": "proofread",
  "label": "Proofread text",
  "details": "Review spelling and clarity.",
  "dependsOn": ["draft"],
  "minutes": [15, 30, 45]
}
```

Dependencies mean that **all** listed predecessors must finish before the task
can start. Roots use `[]`. Unknown dependencies, duplicates, self-dependencies,
and cycles are rejected before any API request. `graph` validates the input and
prints the collection order without credentials, state changes, or network calls.

Install [PingRoom](https://pingroom.io/i), approve the pairing link, and choose a
**standard private room** containing the planner. Grant `pingroom:rooms:read`,
`pingroom:questions:ask`, and access to that room. Normal permissions and quotas
apply. The planner may be the connecting account or another member.

`inspect` lists member UUIDs and lookup names. Verify the intended person in the
app and put their exact UUID and a local label in `config.json`. Names alone do
not establish identity. One configured planner estimates all tasks.

Pairing saves private `.pingroom/credentials.json` and reuses its saved link
while pending. An existing connection is never overwritten. If pairing creation
is uncertain or the link expires, inspect Connected Agents and resolve or revoke
the old robot before deliberately archiving `.pingroom/pairing.json` for new
setup. Keep uncertain intent while investigating.

Alternatively, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and
`PINGROOM_ROOM`. A complete pair overrides saved credentials; partial or blank
pairs fail. Defining either shell variable selects the entire shell pair, without
borrowing values from `.env`. All local paths resolve from the project directory,
regardless of your shell's working directory.

## Estimate and export

```sh
npm start          # Ask the next task, or read the current Question once.
# Answer in PingRoom, then rerun:
npm start
npm run status     # Read saved evidence without credentials or network.
npm run report     # Also write private .planning/report.json.
```

Each invocation creates or reads at most one Question. Tasks are asked in
successive topological layers, with IDs sorted within each layer. Only one
Question is active at a time, and each lasts 15 minutes. The starter installs no
scheduler or background runner; serialize invocations from your existing workflow.

The planner chooses an exact minute value or **Unknown**. They estimate the
task's own elapsed duration after its prerequisites finish, excluding prerequisite
time and assuming uninterrupted work. If none of the offered values is a
defensible estimate, they should choose Unknown rather than round silently.

Unknown is an explicit response. Unasked, pending, expired, cancelled, invalid,
and uncertain outcomes remain separate. None becomes zero or an inferred duration.
Other tasks may still be estimated, but `plan` stays `null` until every task has a
valid numeric estimate. Terminal requests are not reissued within the session.

The report preserves each estimate's Question ID, responder UUID, asking
registration, and answer/observation timestamps. `unknownTaskIds` contains
explicit Unknown responses; `unansweredTasks` lists missing valid answers.
Completed evidence replays locally and does not claim current room access or
freshness of the estimates.

A complete `plan` contains:

- `projectDurationMinutes`: earliest completion of every task under the assumptions.
- Per-task `earliestStartMinutes` and `earliestFinishMinutes`, relative to time zero.
- `latestStartMinutes` and `latestFinishMinutes`: latest times preserving that
  project duration. Their difference from earliest times gives `totalSlackMinutes`.
- `critical`: zero total slack. `criticalEdges` and `criticalPaths` preserve all
  equally long dependency paths, including separate critical branches.

For durations of 15 minutes drafting, 30 illustrating, 15 proofreading, and 10
packaging, completion is at minute 55. Proofreading has 15 minutes of slack;
drafting, illustration, and packaging form the critical path. Slack is not a
budget that every task can independently spend at once.

The calculation assumes **finish-to-start dependencies, zero lag, unlimited
parallel resources, fixed human estimates, and continuous relative minutes**.
It does not model shared workers, equipment contention, calendars, breaks,
probability distributions, or resource-constrained critical-chain scheduling.
Revalidate estimates, dependencies, resource constraints, and source revisions
before turning the proposal into an operational schedule.

Exit codes for `start`/`recover`: `0` complete numeric plan; `2` incomplete plan or
newly observed expired/cancelled/invalid answer; `3` ready/pending/interrupted;
`4` uncertain creation; `1` errors. A newly recorded Unknown can leave `ready`
while other tasks remain; the final incomplete plan exits `2`. Local commands
exit `0` when readable; inspect their JSON for plan status.

## Resume and recover

The journal binds the exact graph, duration choices, participant configuration,
room, and credential fingerprint. Changes are refused. Before each POST, it saves
and syncs the fixed request, 900-second TTL, correlation, and idempotency key.
A crash, lost or malformed response, or failed save can leave `create_unknown`.
Later runs neither repeat that POST nor ask another task until recovery.

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

`find-id` reads up to 200 recent Questions and prints matching candidates. No
match does not prove creation failed. Find the original ID in the originating
robot's history or saved response when needed. Recovery reads that exact ID and
checks the saved request, room, target, asking registration, and timestamps before
attaching it. It sends no question. Deleting state or running another checkout
can create duplicates; keep uncertain records while investigating.

Answers require the named server-authenticated responder and an exact option.
Answer and resolution timestamps must agree and fall within the Question's
lifetime. Expiry may be observed at or after its deadline. Implausible future
timestamps fail, with 60 seconds allowed for local clock skew.

After resolving active or uncertain work, archive the entire private `.planning/`
directory before starting a revised graph with a new plan ID. Preserve old
evidence. Reads need the original registration; reconnecting does not recover
inaccessible Questions. There is no automatic migration.

## Adapt and verify

`src/engine.js` exports `step` for workflow runners. `src/model.js` owns graph
validation, attribution, and critical-path calculations. Keep these deterministic
rules in application code; no AI service is required. Input text never becomes
commands, fetched URLs, or executable instructions.

Plan IDs allow 40 characters; task IDs allow 24. They start with a lowercase
letter and use lowercase letters, digits, `_`, or `-`; prototype keys are
rejected as task IDs. Titles allow 60 printable ASCII characters, task labels 40,
details 100, and planner labels 60, without outer spaces. Each task has at most
11 distinct predecessors. The maximum chain is 5,760 estimated minutes.

Input/configuration files are capped at 16 KiB, state/reports at 1 MiB, and HTTP
bodies at 512 KiB. Writes use a private temporary file, file sync, rename, and
directory sync. One process owns each directory's lock. After a crash, inspect
`.planning/.lock/owner.json` or `.pingroom/.lock/owner.json`, confirm the owner has
stopped, then remove only its stale lock. Restore corrupt state from a valid
backup. Local persistence and server idempotency do not guarantee distributed
exactly-once execution.

Credentials, local inputs, state, and reports are ignored by Git. Files use `0600`
and directories `0700` on POSIX; keep backups private. The
[official SDK](https://github.com/pingroom/sdk) is pinned to `0.6.0` with a lockfile
and 14-day minimum release age. Requests use the official API origin, refuse
redirects, and have a five-second deadline through body consumption. CI tests
Node 22 and 24 with mocks; live phone delivery is not tested.

Unlike [data completion](https://github.com/pingroom/starter-data-completion), this
workflow turns estimates into dependency timing and slack. Unlike
[shift assignment](https://github.com/pingroom/starter-shift-assignment), it does
not allocate people or enforce staffing capacity.

MIT licensed; see [LICENSE](LICENSE).
