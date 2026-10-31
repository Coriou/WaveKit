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

## Get a machine token

Agents use the machine credential, never a browser session. On the host, with the private
state directory the core uses (the core may be running):

```sh
mkdir -p -m 700 "$HOME/.config/wavekit"
node dist/access-command.js machine-token \
  --private-directory "$PRIVATE_DIRECTORY" \
  --out "$HOME/.config/wavekit/machine-token"
```

The command writes the file with mode `0600` and never prints the credential. The target
directory must exist, must not be writable by group or others, and must lie outside the
private directory. An existing file is refused; `--replace` overwrites your own `0600` file.
In Docker, run the same command in a one-off container with the private directory mounted
([Docker setup](DOCKER-SETUP.md#protected-runtime-deployment)).

Once the file exists, load the header the recipes below send:

```sh
AUTH="Authorization: Bearer $(cat "$HOME/.config/wavekit/machine-token")"
```

There is no HTTP route that issues a token. Rotating the credential
(`rotate-credential`, core stopped) revokes every copy; on the host run `machine-token --replace`
afterwards. In Docker the file belongs to the container user, so `--replace` refuses it: delete
the old file and run the one-off command again, as in
[Docker setup](DOCKER-SETUP.md#protected-runtime-deployment). Keep the file private and never put the token in a URL or a log. Details:
[API: automation and agents](API.md#automation-and-agents) and [Security](SECURITY.md).

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

## Check decoders

```sh
curl --fail --header "$AUTH" "$API_ORIGIN/api/decoders/summary"
```

One entry per decoder: `state`, `placements`, `eventsOut`, `lastOutputAt`,
`suspensionReason`, `health` and a `verdict` whose `actions` say what to try first
([GET /api/decoders/summary](API.md#get-apidecoderssummary)).

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

## Pause and resume

Pausing and resuming decoding for an agent's own work is not part of the API yet. This
page will describe it when available.
