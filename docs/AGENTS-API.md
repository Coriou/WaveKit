# Driving WaveKit from an agent or script

Recipes for the tasks an agent or script does most: authenticate, read the receiver state,
tune, set gain, check decoders, read activity and capture IQ. Each recipe is a `curl`
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
curl --fail --header "$AUTH" "$API_ORIGIN/docs/json"     # OpenAPI 3: parameters, bodies, bounds
curl --fail --header "$AUTH" "$API_ORIGIN/api/enums"     # accepted values of the closed lists
```

`GET /api` answers `{ openapi, enums, routes }`; `openapi` and `enums` hold the last two paths.
Paths in the OpenAPI document are relative to the origin you fetched it from. A page size has its
maximum there (`GET /api/recordings`, parameter `limit`), and past the maximum the route answers a
400 that states it ([Read a 400](#read-a-400)).

`GET /api/enums` lists scanner protocols, identity kinds, confidences, job modes, job kinds and
sensitivities, activity kinds and categories, tuner modes and recording kinds.

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

The client reads the file once when it starts and sends the header on every request. In a shell,
load the header the recipes below send:

```sh
AUTH="Authorization: Bearer $(cat "$HOME/.config/wavekit/machine-token")"
```

On a host shared with other users, `curl --header "$AUTH"` shows the token in `ps`. Use a client
that reads the file itself there.

| Answer                   | Meaning                                                       | What to do                                                 |
| ------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| 401 `AUTH_REQUIRED`      | The token is not the current credential: it was rotated       | Re-read the file once and retry once, then ask an operator |
| 503 `ACCESS_UNAVAILABLE` | The core cannot vouch for its credentials and needs a restart | Ask an operator; the token may still be fine               |
| Connection failure       | The core is stopped, for example during a rotation            | Retry with a delay; do not change the token                |

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

## Read the receiver state

One bounded read (under 4 KiB) says what the receiver is doing: tuners, sources, live audio,
scanner, decoder verdicts, activity store and the newest decode per protocol.

```sh
curl --fail --header "$AUTH" "$API_ORIGIN/api/agent/status"
```

Check `tuners[].owner` before tuning: `wavekit` means WaveKit commands the tuner, `external`
means another client (for example SDR++ through the relay) controls it and WaveKit sends no
commands, `scanner` means a scanner job holds the tuner. `truncated: true` means a list or an
id was cut; read the fuller route named in the [field table](API.md#get-apiagentstatus).
Decoders with a problem verdict are listed first; `hiddenProblems` above 0 means more problem
decoders than fit, so read `GET /api/decoders/summary`.

`sources[].feed` reads `paused` or `resuming` while an operator holds the receiver feed off
and `error` after a failed resume. After a plain resume, `tuningUnverified: true` means the
receiver may have been retuned during the pause: read or set the tuning before trusting it.
`scanner.heldJobs` counts sweeps that a plain resume parked (`reason`
`resumed-without-retune`); `scanner.job` shows one of them before any newer job, and it
waits for an explicit job resume.

## Tune

```sh
curl --fail --header "$AUTH" --header "Content-Type: application/json" \
  --data '{"hz":100000000}' "$API_ORIGIN/api/tuner/rtl/frequency"
```

`hz` is the center frequency in Hz. The answer is the new tuner state. A sample-rate change
(`POST /api/tuner/rtl/sample-rate`, `{"hz":2400000}`) reconnects the source and may answer
503 `SOURCE_RECONNECTING` with `Retry-After: 1`; retry after that many seconds
([sample-rate restarts](API.md#tuner-commands-during-a-sample-rate-restart)).

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
