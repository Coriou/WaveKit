# Driving WaveKit from an agent or script

Recipes for the tasks an agent or script does most: authenticate, tune, read the receiver state,
set gain, check decoders, read activity and capture IQ. Each recipe is a `curl`
command; the full contract of every route is in the [API reference](API.md).

The examples assume a protected core, its API origin in a shell variable, and the machine token
from the next section:

```sh
API_ORIGIN="https://receiver.example:9443"   # your core's API origin
```

`100000000` (100 MHz) and the source id `rtl` are examples: read your own source ids from
`GET /api/agent/status` or `GET /api/sources`.

## Discover the API

The first step for a fresh agent, once it has the token from the next section. Three reads
describe everything else, and all three take the same token as any other API read (without one, a
protected core answers 401):

```sh
curl --fail --header "$AUTH" "$API_ORIGIN/api"           # every route, plus the two URLs below
curl --fail --header "$AUTH" "$API_ORIGIN/docs/json"     # OpenAPI 3.1: parameters, bodies, bounds
curl --fail --header "$AUTH" "$API_ORIGIN/api/enums"     # accepted values of the closed lists
```

`GET /api` answers `{ openapi, enums, routes }`; `openapi` and `enums` hold the last two paths.
Paths in the OpenAPI document are relative to the origin you fetched it from. A page size has its
maximum there (`GET /api/recordings`, parameter `limit`), and past the maximum the route answers a
400 that states it ([Read a 400](#read-a-400)).

`GET /api/enums` lists scanner protocols, identity kinds, confidences, job modes, job kinds and
sensitivities, the discovery and job list views, activity kinds and categories, tuner modes, tune
settings and restore statuses, and recording kinds.

## Get a machine token

Agents use the machine credential, never a browser session. A core has exactly one, created by
[`setup`](LOCAL-SETUP.md#protected-mode-locally) and kept in the core's private state directory.
You copy it into a file once; the agent then needs no `docker exec` and no shell in the container.
No HTTP route issues a token, and a browser pairing code is not one.

### Mint

On the host, with the private state directory the core uses. The core may be running or stopped:

```sh
mkdir -p -m 700 "$HOME/.config/wavekit"
node dist/access-command.js machine-token \
  --private-directory "$PRIVATE_DIRECTORY" \
  --out "$HOME/.config/wavekit/machine-token"
```

In Docker, run the same command in a one-off container that mounts the private volume and a host
directory: [the exact commands](DOCKER-SETUP.md#give-an-agent-the-machine-credential). A failure
reading `ACCESS_CREDENTIAL_UNAVAILABLE` means the directory has no provisioned credential yet, or
is not your own `0700` directory.

### Store

The command writes the file with mode `0600` and never prints the credential. The target directory
must exist, must not be writable by group or others, and must lie outside the private directory.
An existing file is refused; `--replace` overwrites only your own `0600` file. Hand the file to an
agent on another machine over a secure channel. Never put the token in a URL or a log. An export
killed partway can leave a `0600` `.machine-token-*.tmp` beside the file, holding the same token;
delete it, and if `--replace` then still answers `ACCESS_TOKEN_OUT_UNSAFE`, delete the file too and
export again.

The file is a copy of the one credential, not a separate grant, and it has no expiry. It stays valid
across core restarts and image recreates for as long as the private directory persists. Deleting
that directory (`docker compose down -v` on a named volume, or stopping `make dev-protected`
without `--keep`) destroys the credential: a new `setup` creates a different one.

### Use

The client reads the file once when it starts and sends the header on every request. For `curl`,
keep the header in a private file beside the token, so the token is never on a command line where
`ps` shows it. Create it once, and again after every rotation (`printf` is a shell builtin, so this
line does not show the token either):

```sh
install -m 600 /dev/null "$HOME/.config/wavekit/machine-token.header"
printf 'Authorization: Bearer %s\n' "$(cat "$HOME/.config/wavekit/machine-token")" \
  > "$HOME/.config/wavekit/machine-token.header"
```

Then point the recipes below at that file. `curl --header @file` reads the header from it:

```sh
AUTH="@$HOME/.config/wavekit/machine-token.header"
```

| Answer                   | Meaning                                                     | What to do                                                                                                                  |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 401 `AUTH_REQUIRED`      | The token is not the current credential: it was rotated     | Re-read the file once and retry once, then ask an operator                                                                  |
| 503 `ACCESS_UNAVAILABLE` | The core cannot vouch for its credentials and is restarting | Retry with a delay; the token may still be fine. `GET /health`, which needs no token, then says 503 `access_authority_lost` |
| Connection failure       | The core is stopped, for example during a rotation          | Retry with a delay; do not change the token                                                                                 |

### Rotate and revoke

Revoking is rotating: there is one machine credential, so replacing it revokes every copy at once
and every agent needs the new one. Rotation runs with the core stopped:

```sh
# Stop the core, then:
node dist/access-command.js rotate-credential --private-directory "$PRIVATE_DIRECTORY"
node dist/access-command.js machine-token --replace \
  --private-directory "$PRIVATE_DIRECTORY" \
  --out "$HOME/.config/wavekit/machine-token"
# Start the core again.
```

- **Browsers.** By default rotation also removes every remembered browser, so each one pairs again.
  `--keep-sessions` keeps browsers paired; review them with `devices list` after the restart.
- **While a core runs.** Rotation is refused with `ACCESS_STORAGE_BUSY` (or
  `ACCESS_STORAGE_FOREIGN_OWNER` from another container) and the token stays valid. Rotation waits up
  to 40 seconds for the lock of a core that was killed without a clean exit.
- **What an agent sees.** Connection failures from stop to start, including on `/health`. After the
  start, the old token gets 401, so export the new file before starting the core and the agent's
  retry finds it.
- **If rotation fails after it started writing,** the message says the credential may have been
  replaced. Rotate again and export again.
- **`ACCESS_STORAGE_CREDENTIAL_MISMATCH`.** The stored credential is not the one the last rotation
  recorded, so it may be a revoked one. The core does not start and `machine-token` writes nothing.
  Rotate again without `--keep-sessions` (it is refused here, so every browser pairs again) and
  export again.
- **In Docker,** the exported file belongs to you after the `chown`, so `--replace` refuses it: delete
  it and export again, as in the [exact commands](DOCKER-SETUP.md#rotate-the-machine-credential).

To revoke one browser instead, use [`devices revoke`](API.md#protected-runtime-opt-in) against the
running core; it leaves the machine credential alone.

### A core without protection

Legacy mode is the default (no `access` block, and `pnpm start:local`). It has no access check at
all: no credential is needed, the `Authorization` header is ignored, and every route is open to
whoever can reach the port, so the core's bind address is the only boundary
([Security](SECURITY.md#access-and-pairing)). A token grants nothing extra there, and running
`setup` or `machine-token` does not turn protection on. A request without a token that gets 200 from
`GET /api/agent/status` means the core is unprotected; a protected core answers 401.

Details: [API: automation and agents](API.md#automation-and-agents) and [Security](SECURITY.md).

## Tune

One call sets the rate, the centre and the gain, and answers once the source delivers IQ again, so
a rate change needs no retries:

```sh
curl --fail-with-body --header "$AUTH" --header "Content-Type: application/json" \
  --data '{"sampleRateHz":2400000,"frequencyHz":100000000,"gainMode":"manual","gain":372}' \
  "$API_ORIGIN/api/tuner/rtl/tune"
```

Send at least one of `sampleRateHz`, `frequencyHz`, `gainMode` and `gain` (tenths of a dB). The
answer is the tuner state of `GET /api/tuner` (`sampleRate`, `frequency`, `gainMode`, `gain`) plus
`usable`, `applied` and `notApplied`. It takes up to 18 s; give your client a longer timeout. Past
that, or when a write fails, the answer is an error that still says what was and was not applied.
A 503 with `usable: false` also carries `sourceVerdict`, the reason the source is silent. A 409
`TUNER_TUNE_OVERRIDDEN` means someone else changed the tuner during or after your tune, and any setting
not yet written was not sent: read `state.lastChange` before tuning again. Read the [whole contract](API.md#post-apitunersourceidtune).

### When a scan holds the tuner

A tune never takes the receiver from a running scan unasked. While a job holds the tuner's lease the
answer is 409 `TUNER_LEASE_HELD` with `jobId` and `jobName`, and nothing is written. A lease that
arrives while your tune is writing stops it the same way, and `applied` says what stands. Decide with
whoever runs the scan, then send `"preempt": true`:

```sh
curl --fail-with-body --header "$AUTH" --header "Content-Type: application/json" \
  --data '{"frequencyHz":100000000,"restoreAfterS":30,"preempt":true}' "$API_ORIGIN/api/tuner/rtl/tune"
```

This holds for a tune to where the scan already sits, too: asking to stay on the job's hop, or for a
gain already in place, sends a frame so that the job really stops and the tuner stays.

The 200 then carries `preempted`: `jobId`, `jobName`, `job` (`paused`, or `failed` if it was still
starting), `autoAfterIdleMs`, `waiters` and `message`. Read `autoAfterIdleMs` before you rely on the job
coming back:

- A number: the job resumes by itself that long after the last operator write (60 s by default), or
  later if activity holds it, even in the middle of a longer `restoreAfterS`.
- `null`: **a short look stops the scan until someone calls `POST /api/scanner/jobs/:id/resume`.** A job
  somebody had already paused reads `null` too, whatever its own rule: it never resumes by itself. So
  does a job that was still starting: it failed, and only a new start brings it back.

`waiters` lists other jobs that lost this tuner, to a job or to an operator, and can take it once it is
idle, each with its own `autoAfterIdleMs`, so the job you stopped may not be the one that moves the receiver next. Cancel
one if you need longer.

### Tune for a while

Add `restoreAfterS` (1 to 3600) and the core puts the prior rate, centre and gain back by itself:

```sh
curl --fail-with-body --header "$AUTH" --header "Content-Type: application/json" \
  --data '{"frequencyHz":100000000,"restoreAfterS":60}' "$API_ORIGIN/api/tuner/rtl/tune"
curl --fail --header "$AUTH" "$API_ORIGIN/api/tuner/rtl"                        # see "restore"
curl --fail --header "$AUTH" --request DELETE "$API_ORIGIN/api/tuner/rtl/tune/restore"  # keep it
```

The person at the receiver wins: any later write to this tuner from anyone, including the web app,
an external client such as SDR++ or a scanner job, cancels the restore for good and never gets
overwritten. A scanner job taking the tuner's lease cancels it as well, and the receiver ends on your
temporary tuning when the job ends: a restore itself never preempts a job. `restore` in `GET /api/tuner` says what happened: `status`, `at`, `state` (what goes back) and
`cancelledBy`. A core restart drops a pending restore: read
[what a restart does](API.md#temporary-tune-and-restart) before relying on one.

With `preempt: true` over a scan, **no restore comes**: `restore` reads `cancelled` with reason
`scanner-preempted` from the start. Going back would mean going to the job's hop, and the tuning from
before the job is not kept either. When `restoreAfterS` passes nothing happens: the receiver stays on
your tune until the job resumes by its own rules and retunes, or someone tunes it. If you need your own
tuning back afterwards, tune to it.

## Read the receiver state

One bounded read (under 4 KiB) says what the receiver is doing: tuners, sources, live audio,
scanner, decoder verdicts, activity store and the newest decode per protocol. Poll this route to
ask "what is going on": it reads no discovery, journal or SQLite data, so it stays cheap on a busy
core and however many discoveries the store holds.

```sh
curl --fail --header "$AUTH" "$API_ORIGIN/api/agent/status"
```

Check `tuners[].owner` before tuning: `wavekit` means WaveKit commands the tuner, `external`
means another client (for example SDR++ through the relay) controls it and WaveKit sends no
commands, `scanner` means a scanner job holds the tuner. `truncated: true` means a list or an
id was cut; read the fuller route named in the [field table](API.md#get-apiagentstatus).
Decoders with a problem verdict are listed first; `hiddenProblems` above 0 means more problem
decoders than fit, so read `GET /api/decoders/summary`.

Each answer below is one read, no logs needed; every closed list is in `GET /api/enums`:

- **Who moved the tuner, and why:** `lastChange` on `GET /api/tuner` (`actor`, `reason`, `at`,
  `fields`, and `jobId` when a job moved it). A machine token reads `agent`, a browser session
  `web`, a core without access `unknown`.
- **Why a source gives no samples:** `verdict` on `GET /api/sources`, its bare code as
  `sources[].verdict` here (absent when `ok`). `receiver-no-device` means fresh receiver facts say
  so; `no-samples` claims no cause, and `deviceFacts` says why not (`probe-failed`: the receiver
  answered, but its USB check failed, so the device may well be there).
- **Why passive scanning is off:** `sources[].passive` here, `engines[].passive.reasonCode` on
  `GET /api/scanner`; `engines[].lastPassiveStartFailure` when its job failed to start.
- **Why a scan did not get the tuner back on its own:** `engines[].lastLeaseRefusal` on
  `GET /api/scanner` (`kind`, `code`, `at`, `holderJobId` when known).
- **Why the core is slow:** [`GET /api/diagnostics`](API.md#get-apidiagnostics): event-loop
  delay, CPU by thread and open channels, one shared sample every 2 s, so poll it freely. Read
  it twice: the first answer has no CPU window yet.
- **Why a signal was not recorded:** `recorder` on `GET /api/scanner/discoveries/:id`.
- **What a sweep was allowed to disturb:** `impact` and `consentedImpact` on the job.

`sources[].feed` reads `paused` or `resuming` while an operator holds the receiver feed off
and `error` after a failed resume. After a plain resume, `tuningUnverified: true` means the
receiver may have been retuned during the pause: read or set the tuning before trusting it.
`scanner.heldJobs` counts sweeps that a plain resume parked (`reason`
`resumed-without-retune`); `scanner.job` shows one of them before any newer job, and it
waits for an explicit job resume. `scanner.discoveries` is how many records the discovery store
holds.

## List what the scanner found

Ask for compact rows: 200 to 300 bytes each, instead of 760 or more.

```sh
curl --fail --header "$AUTH" "$API_ORIGIN/api/scanner/discoveries?view=compact&limit=100"
```

Each row has `id`, `frequencyHz`, `class`, `protocol`, `confidence`, `evidenceLevel`, `identity`,
`lastSeenAt` and `recorder`. `identity` is null while none is published, and `recorder` is null
while the recorder remembers no decision; `recorder.last` holds its last `code` and `at`. There is
no `state`: a discovery is a record, not a process, and only a job has one. Pass `nextCursor` as
`cursor` for the next page, until it is null. All the filters work
([compact rows](API.md#compact-rows)). A page can come back short of `limit` when a record is
merged during the read, so stop on the cursor, not on the row count.

While a sweep runs, walk with `sort=frequency`. The cursor is an offset into the order of that
moment, and the default order follows `lastSeen`: every re-heard signal jumps to the front and pushes
the rest down, so the next page repeats some rows and never shows others. Being heard again does not
move a record in this order:

```sh
curl --fail --header "$AUTH" "$API_ORIGIN/api/scanner/discoveries?view=compact&sort=frequency&limit=100"
```

A record new to the store can still shift the offset by a row, so keep rows by `id`.

`GET /api/scanner/jobs?view=compact` is the same for jobs: `id`, `name`, `kind`, `state`, `reason`,
`sourceId` and `updatedAt`, without the plan. It tells you whether a job is still going, and has no
progress by design. To follow a sweep, poll `progress` on the one job:
`GET /api/scanner/jobs/<id>` (`sweepIndex`, `hopIndex`, `hopCount`, `coverage`, `counts`). That answer
carries the whole plan too, about 160 bytes per hop, so poll it at human pace, not in a tight loop.

## Set gain

```sh
curl --fail --header "$AUTH" --header "Content-Type: application/json" \
  --data '{"mode":"manual"}' "$API_ORIGIN/api/tuner/rtl/gain-mode"
curl --fail --header "$AUTH" --header "Content-Type: application/json" \
  --data '{"gain":372}' "$API_ORIGIN/api/tuner/rtl/gain"
```

`gain` is in tenths of a dB (0 to 500; `372` is 37.2 dB), the same unit as `gain` in
`GET /api/tuner` and `GET /api/agent/status`. `{"mode":"agc"}` returns to automatic gain.
`tenthsDb` is a deprecated alias of `gain` that older clients still send; use `gain`.

### Tuner field names

Each single-setting `POST` route has its own short body field. Sending the name `GET /api/tuner`
reports instead is a 400 that names the field the route expects:

| `GET /api/tuner` field | `POST` route           | Body field |
| ---------------------- | ---------------------- | ---------- |
| `frequency`            | `.../frequency`        | `hz`       |
| `sampleRate`           | `.../sample-rate`      | `hz`       |
| `gainMode`             | `.../gain-mode`        | `mode`     |
| `agcMode`              | `.../agc`              | `enabled`  |
| `biasTee`              | `.../bias-tee`         | `enabled`  |
| `directSampling`       | `.../direct-sampling`  | `mode`     |
| `offsetTuning`         | `.../offset-tuning`    | `enabled`  |
| `testMode`             | `.../test-mode`        | `enabled`  |
| `ifGain`               | `.../if-gain`          | `gain`     |
| `rtlXtal`              | `.../rtl-xtal`         | `hz`       |
| `tunerXtal`            | `.../tuner-xtal`       | `hz`       |
| `tunerGainIndex`       | `.../tuner-gain-index` | `index`    |
| `controlMode`          | `.../control-mode`     | `mode`     |

`gain`, `ppm` and `tunerIfGain` (`stage`, `gain`) keep their names. To use the `GET` names
throughout, send them to `PATCH /api/tuner/:sourceId/config`, which takes those names and units
and answers 400 for any other field.

## Check decoders

```sh
curl --fail --header "$AUTH" "$API_ORIGIN/api/decoders/summary"
```

One entry per decoder: `state`, `placements`, `eventsOut`, `lastOutputAt`,
`suspensionReason`, `health` and a `verdict` whose `actions` say what to try first
([GET /api/decoders/summary](API.md#get-apidecoderssummary)). A verdict `cause` of `host`
means the host is busy (samples were dropped on several streams): lowering one decoder's
sample rate will not help it; `retryAt` says when a decoder stopped for its own loss is
tried again. The rows of `GET /api/agent/status` carry `cause` only on a loss verdict
(`efficiency-drops`, `efficiency-late-drops`, `efficiency-cpu`) and never `retryAt`: read
the summary route for it.

After a dwell with no output, tell "nothing on air" from "heard but undecodable" with
`reception` (also on the `listening` rows of `GET /api/agent/status`): `heard-undecoded`
means the decoder heard its protocol (preambles, syncs, bursts) but decoded none of it,
`nothing-heard` means it heard nothing it recognises. It reads only what the decoder heard
since it last started, restarted or moved channel or centre (evidence at most 2 hours old,
a removed channel placement's evidence dropped), so a retune or restart starts it afresh.
The LoRa, ISM (rtl_433) and digital voice (dsd-fme) decoders report it, with the underlying `counters` (`total` since the core
started, `perMin` over the last minute) on the summary route.

Quiet or broken: `listening` is quiet (running, nothing decodable), even with `health: idle`
and sparse output. `source-unavailable` with `input: none` is broken (running, no input); `failed`
is a failing process ([table](API.md#get-apidecoderssummary)).

For a failing decoder, `lastError` on `GET /api/decoders/:id` gives the cause, kept across
automatic restarts, and [`GET /api/decoders/:id/log?lines=50`](API.md#get-apidecodersidlog) its
recent output. That output is raw and can contain decoded data, so treat it like Activity rows.

## Read activity

```sh
curl --fail --get --header "$AUTH" \
  --data-urlencode "protocols=adsb,ais" \
  --data-urlencode "producedFrom=2026-01-01T00:00:00Z" \
  --data-urlencode "order=desc" --data-urlencode "limit=50" \
  "$API_ORIGIN/api/activity"
```

Filters: `kinds`, `sourceIds`, `decoderIds`, `protocols`, `categories` (comma lists or
repeated), `frequencyMin`/`frequencyMax` (Hz), `producedFrom`/`producedTo` (ISO times),
`entityKey`, `text`, `refs`, `order` (`asc` or `desc`), `limit` (default 100, at most 200),
`pageToken`. Pass `nextPageToken` from the answer as `pageToken` for the next page; a token
expires with its snapshot after 5 minutes. A 429 `ACTIVITY_QUERY_BUSY` carries
`Retry-After` ([GET /api/activity](API.md#get-apiactivity)).

## Capture IQ

Store a few seconds of the current tuning as a named CU8 file, then download it.

```sh
curl --fail --header "$AUTH" --header "Content-Type: application/json" \
  --data '{"name":"test-capture","seconds":2}' "$API_ORIGIN/api/iq/captures"
curl --fail --header "$AUTH" "$API_ORIGIN/api/iq/captures"
curl --fail --header "$AUTH" --output test-capture.cu8 \
  "$API_ORIGIN/api/iq/captures/test-capture"
curl --fail --header "$AUTH" --request DELETE \
  "$API_ORIGIN/api/iq/captures/test-capture"
```

The POST answers 201 once the capture is stored, with its `centerHz`, `sampleRate`, `gain`,
`startedAt`, `durationS`, `bytes` and `sourceId`. `seconds` is a whole number from 1 to 10;
add `sourceId` when the core has more than one source. Names use `a-z`, `0-9`, `-` and `_`
and must be unique. One capture runs per source at a time (409 `IQ_CAPTURE_BUSY`); a retune
while the request is admitted answers 409 `IQ_CAPTURE_SOURCE_CHANGED` (retry); a full store
answers 507 ([IQ captures](API.md#named-iq-captures)). For a one-off window streamed
straight to you without storing it, use the
[IQ snapshot](API.md#current-window-iq-snapshot).

## Is that DMR at this frequency?

`POST /api/scanner/identify` answers without moving anything: it never retunes and never moves live
audio. Ask, then poll the job until it has ended:

```sh
curl --fail-with-body --header "$AUTH" --header "Content-Type: application/json" \
  --data '{"sourceId":"rtl","target":{"frequencyHz":446100000},"protocols":["dmr"]}' \
  "$API_ORIGIN/api/scanner/identify"
curl --fail-with-body --header "$AUTH" "$API_ORIGIN/api/scanner/jobs/<id>"
```

**201** started a job. **200** means a running job already asks this, and you have that job: same
source, a frequency within its `max(1 kHz, bw/2)`, your `protocols` contained in its own, asking no
more than it does, and with at least 90 % of the wait you asked for still left (a job already running
trials on the signal joins too). Repeating a 15 s request joins for its first 1.5 s; later it starts a new job, whose
runs wait up to 3 s for the probe slot if another job holds it, then answer `could-not-test` (`budget`).
A finished job is never reused.

Read `identify.targets[0].verdict` once the target is final. Say only what it says:

| `verdict.code`              | Say                                                                        |
| --------------------------- | -------------------------------------------------------------------------- |
| `decoded`                   | It is `verdict.protocol`, which may not be the protocol you asked about    |
| `heard-digital-unconfirmed` | Possibly `verdict.protocol`: a lone sync or one decode, not a confirmation |
| `undecodable`               | Something is there, and the trials decoded nothing                         |
| `nothing`                   | No signal within `timeoutMs`                                               |
| `could-not-test`            | No answer. `verdict.why` says why; do not read it as "not DMR"             |

`decoded` needs two matching decodes 2 s to 5 min apart, so a continuous transmission takes about 2.5 s
from its first decode, and a single short burst with no earlier match stays `heard-digital-unconfirmed`.
The lists are in `GET /api/enums` (`scanner.identifyVerdictCodes`, `scanner.identifyVerdictWhy`).

`verdict.confirmedAcrossJobs: true` on a `decoded` means this request heard one burst and the match came
earlier: a matching decode within the last 5 min on this signal, or an identity already accepted on it.
That earlier decode may be another request's, or a scan's. Say "it was DMR on this signal a moment ago and
this burst matches", not "two decodes just now". It is set for dsd-fme protocols (DMR, P25, NXDN, YSF,
D-STAR, dPMR) on a live probe run; a decode from an ambient decoder or a pager does not set it.

A signal that comes and goes: send `"waitUntilSignal": true`, with `waitMs` for how long.

**When it answers 409**, `details.next` is the call to make, in fixed text:

- `OUT_OF_WINDOW`: the frequency is outside the tuned window (`details.window`). `next` is a
  `POST /api/tuner/:sourceId/tune` with a `frequencyHz` that puts the target and its `bandwidthHz` inside
  the window, off the DC spike. It moves the receiver for everyone, so decide that first; then ask again.
  If no centre fits at this sample rate, `next` has only `effect`, saying so: no `method`, no call to make.
- `SCANNER_SOURCE_BUSY`: a sweep holds the tuner, and identify needs a still window. `next` adds
  `preempt: true`. That pauses the job (it fails if it was still starting) and no restore comes; read
  `preempted.autoAfterIdleMs` in the answer, because `null` means it stays paused until someone calls
  `POST /api/scanner/jobs/:id/resume`. See [When a scan holds the tuner](#when-a-scan-holds-the-tuner).
  With `details.reason: "relay"` there is no `next`: a relay client has the tuner.

**What it costs.** Each live probe run is one offset probe, 0.5 core of the 1-core `cpuBudgetCores`
by default, one at a time; ambient and live-audio trials start no probe, they read what already runs. `timeoutMs` (default 15 s, at most 120 s) bounds the wait for a signal, not the trials.
A DMR trial lasts about 2.2 s on silence and at most about 5.3 s after a first decode. Naming
`protocols` keeps it to the trials you need; without it every plausible decoder takes its turn.

**What it does to the rest.** Its probes preempt scan and passive probes at once (priority 101), for
that short, bounded time; they come back by themselves. A sweep blocks it (409 above), and a retune
that moves the window off the target ends it as `could-not-test` with `why: "window-moved"`.
`trials[].transport` says which path each trial took; this core runs every live trial as `offset`.

## Read a 400

Every validation 400 names the failing field and what it accepts, never the value you sent:

```json
{
	"error": "ValidationError",
	"code": "VALIDATION_ERROR",
	"message": "Invalid request body: seconds: integer, seconds (1 to 10)",
	"fields": [{ "field": "seconds", "expected": "integer, seconds (1 to 10)" }]
}
```

Fix each entry of `fields` (`field` is the schema name, `expected` its type, range and
unit) and resend. Routes with their own error code (for example `SCANNER_PLAN_INVALID` or
`ACTIVITY_QUERY_INVALID`) keep that `code` and add the same `fields`. One exception:
`PATCH /api/station` keeps `fields` as a list of field names (`["lat"]`) for the web settings
form; its `message` states what each named field accepts
([validation errors](API.md#validation-errors)).

Most routes ignore a body field they do not know, so a misspelled name reads as an absent one.
`POST /api/scanner/plan`, `POST /api/scanner/jobs` and `PATCH /api/tuner/:sourceId/config` answer
400 for an unknown top-level field instead, and their `fields` list the accepted names.

## Pause and resume

Pausing and resuming decoding for an agent's own work is not part of the API yet. This
page will describe it when available.
