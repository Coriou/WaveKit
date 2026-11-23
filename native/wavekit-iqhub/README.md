# wavekit-iqhub

One process per IQ source. It owns the TCP connection to an rtl_tcp-style endpoint, writes the
tuner commands, and fans the payload out to **sinks**: Unix-socket connections that a parent
process hands to child processes (as their stdin, for example). It does no DSP.

- **It never blocks** on a sink, on its own event output or on the control fd, and it never
  pauses the source. A sink can only delay itself. A parent that stops reading events loses
  `progress` lines only.
- **A sink's loss is one contiguous skip of whole frames**, reported once with its position
  and size.
- **Positions are exact.** `sourcePos` counts whole-frame payload bytes of the adopted streams
  since the latest `configure` (headers excluded; a stream's trailing partial frame is
  discarded and never counted). Every event that names a position names it at the instant the
  hub acted.
- **One ring, one thread, one `poll` loop**, no allocation per read in steady state, and a
  sink write goes from the ring to the kernel. Two threads are ruled out: a writer descheduled
  inside `write` could send bytes the reader has already overwritten.
- **The decisions live in a state machine with no I/O and no clock** (`src/hub.rs`). The I/O
  loop (`src/io.rs`) turns readiness into calls and performs the actions it returns; the tests
  drive the same state machine with a simulated kernel.

Nothing in the TypeScript core uses the hub yet.

## Running

```
wavekit-iqhub --control-fd 3 --socket-dir DIR [--ring-ms 4000] [--log-level info|debug]
              [--stats-file PATH]
wavekit-iqhub --version
```

- `--control-fd` (at least 3): JSON-line requests. Read non-blocking. EOF on it, or a
  `shutdown` request, closes everything and exits 0. The fd is checked (`fcntl(F_GETFD)`) and
  taken before the hub creates any fd of its own, so a number the parent did not open can never
  name the hub's listener: a missing or invalid control fd fails start-up (exit 2, one line on
  stderr). Fds 0 to 2 need no check: the Rust runtime opens `/dev/null` on any of them that is
  closed before the hub starts.
- stdout carries the events and must be a pipe or socket the hub owns: the hub switches it to
  non-blocking, which changes the file description it shares with whoever else holds it (a
  terminal or a parent's own stdout would become non-blocking too).
- `--socket-dir`: must exist, be a directory owned by the hub's user and have mode 0700; the
  hub creates `DIR/hub.sock` there with mode 0600 (a stale socket of an earlier hub is
  replaced). The directory is the trust boundary; there is no token. The socket path must be
  at most 103 bytes: macOS's `sun_path` is 104 bytes and includes the terminating NUL; Linux's
  is 108, and the smaller bound is used on both so a configuration is portable.
- `--ring-ms`: 500 to 30 000 (default 4 000), the ring's length in signal time.
- `--log-level debug`: one line per sink with the send buffer requested and granted, and at
  exit the loop's wake-ups, reads, CPU time and context switches. Logs go to stderr, never one
  per chunk.
- `--stats-file PATH`: one JSON line a second, and one at exit, appended to `PATH` (created
  with mode 0600); see "Stats file". A path that cannot be opened fails start-up (exit 2).

Exit codes: 0 after control EOF or `shutdown`; 1 when an event other than `progress` cannot be
queued, when stdout is closed (`EPIPE`) or when `poll` fails; 2 for a bad command line, socket
directory or control fd. A failed write to stderr (closed by the parent) is ignored, so it never
turns one of these into a panic.

Events are JSON lines on stdout, in the hub's action order. stdout is non-blocking with a
bounded queue of 256 KiB. `progress` is dropped while the queue is not empty (its counters are
cumulative, so nothing is lost); any other event that does not fit ends the process with exit
code 1 after a line on stderr, and from that moment no further event is queued (the output
already has a hole, so the parent never acts on a later event before it sees the exit).

The hub stops reading control lines while the queue holds more than half its bound (128 KiB):
the lines already read wait in its line buffer, the rest in the kernel, until stdout drains.
One line queues at most about 23 KiB (its answer, the `write-failed` of an attempt's 64 pending
commands, a `sink-gap` for each of 32 sinks), so however fast a parent writes requests, they
cannot overflow the queue as long as it reads stdout. So the parent must read the hub's stdout
independently of its control writes (another thread or its own poll loop): a parent that blocks
writing control lines without reading events fills the queue past half, the hub stops reading
control, and both sides stop.

SIGPIPE is ignored. As a second guard a write to a closed peer cannot raise it: on Linux every
send passes `MSG_NOSIGNAL`, on macOS every socket sets `SO_NOSIGPIPE`.

macOS `poll` never reports the writer's close of a FIFO (it does for pipes and sockets), so the
control fd is also read once a second when it did not report readiness: a FIFO's EOF is seen
within a second, at the cost of at most one extra wake-up a second.

## Control requests

Every request is one line `{"v":1,"type":"<request>", ...members}` of at most 65 536 bytes with
its newline. Parsing is strict: a missing required member, an unknown member, a duplicate key,
a wrong type or a value out of bounds is answered with `rejected` and never ends the process.
A longer line is rejected once (`too-long`) and skipped up to the next newline. A partial line
at EOF is discarded. Any request may carry `seq` (an unsigned integer); it is echoed on that
request's answer and on its `rejected`. A `rejected.detail` is at most 128 bytes (cut on a
character boundary): a refusal never echoes more of the input. Ids (`attempt`, `write` and
`mark` ids) are unsigned integers; sink ids match `[A-Za-z0-9._-]{1,64}`.

| Request         | Members (optional in brackets)                                                                                                            | Bounds                                                                                                                                                                                                                                                                                             | Answer                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `configure`     | `byteRate`, `frameBytes`, `levelFormat`, `levelStride` (required unless `levelFormat` is null), [`linkGapMs` = 200], [`progressMs` = 100] | `frameBytes` 1 to 16; `byteRate` 8 000 to 64 000 000 and a multiple of `frameBytes`; `levelFormat` `"u8"`, `"s16le"` or `null`, and `frameBytes` a multiple of its component size; `levelStride` 1 to 1 048 576; `linkGapMs` 20 to 3 600 000; `progressMs` 50 to 1 000                             | `configured`                      |
| `connect`       | `attempt`, `host`, `port`, `timeoutMs`, `headerBytes`, [`headerTimeoutMs`], [`keepAliveMs`], [`rcvBufBytes`]                              | `host` an IP literal (no name resolution); `port` 1 to 65 535; `timeoutMs` 1 to 600 000; `headerBytes` 0 to 64; `headerTimeoutMs` 1 to 600 000; `keepAliveMs` 1 000 to 7 200 000; `rcvBufBytes` 65 536 to 67 108 864; `attempt` greater than every attempt id used before; at most 4 live attempts | `tcp-connected` or `closed`       |
| `adopt`         | `attempt`                                                                                                                                 | the attempt is held, not closing, and a ring is configured                                                                                                                                                                                                                                         | `adopted`                         |
| `abort`         | `attempt`, [`mode` = `"now"`], [`graceMs` = 2 000]                                                                                        | a live attempt; `mode` `"now"`, `"after-writes"` or `"graceful"`; `graceMs` 1 to 60 000, only with `after-writes` or `graceful`                                                                                                                                                                    | `closed {reason: "aborted"}`      |
| `write`         | `id`, `attempt`, `hex`                                                                                                                    | 1 to 64 bytes as hex pairs; at most 64 commands and 4 096 bytes pending on the attempt; the attempt has no front                                                                                                                                                                                   | `written` or `write-failed`       |
| `mark`          | `id`                                                                                                                                      | a ring is configured; while a framed sink is active, at most 1 024 marks at one `sourcePos`                                                                                                                                                                                                        | `marked`                          |
| `sink-open`     | `sink`, `kind` (`"raw"`, `"framed"` or `"front"`), [`maxLagMs` = 2 000], [`resumeMs` = 250], `attempt` (exactly with `kind: "front"`)     | `resumeMs` at least 20; `maxLagMs` at least 2 x `resumeMs` and at most `--ring-ms` / 2; a new id; at most 32 sinks; a front's `attempt` live, not closing and without a front                                                                                                                      | `sink-ready`                      |
| `sink-activate` | `sink`, [`atSourcePos`]                                                                                                                   | a bound sink (not a front) and a configured ring                                                                                                                                                                                                                                                   | `sink-started`                    |
| `sink-update`   | `sink`, `maxLagMs`, `resumeMs`                                                                                                            | as `sink-open`                                                                                                                                                                                                                                                                                     | `sink-updated`                    |
| `sink-close`    | `sink`                                                                                                                                    | a declared sink                                                                                                                                                                                                                                                                                    | `sink-closed {reason: "request"}` |
| `shutdown`      |                                                                                                                                           |                                                                                                                                                                                                                                                                                                    | none: the hub exits 0             |

`configure` sizes the ring: `--ring-ms x byteRate / 1000` rounded up to a multiple of
`frameBytes` (at most 30 000 x 64 000 000 / 1 000 = 1.92 GB; an allocation that fails is
answered `rejected {reason: "no-memory"}`). A `configure` with the current values changes
nothing and is answered `configured`. One with other values closes every bound and active sink
(`sink-closed {reason: "reconfigured"}`), replaces the ring and restarts the `sourcePos` grid and
the stream start at 0; declared sinks stay declared, and the adopted stream continues into the
new ring: its pending partial frame is the start of the next frame, and when the new frame is
smaller the whole frames it already holds count at once (`configured.sourcePos` shows them).

`connect` opens a non-blocking TCP connection with `TCP_NODELAY` (so a 5-byte tuner command
leaves at once instead of waiting for Nagle's acknowledgement) and, with `keepAliveMs`, TCP
keepalive: the first probe after `keepAliveMs` of silence (rounded up to a second), then one
every third of that (at least 1 s), and 3 unanswered probes close the connection, so a dead
peer is found after about twice `keepAliveMs`. `tcp-connected` answers it as soon as the TCP
connection is up, before any byte of it was read (a peer that accepts and then stays silent is
connected and stale, not a failed connect). The hub then reads exactly `headerBytes` and leaves the
payload in the kernel until the attempt is adopted; `connected` says the header is complete (with
`headerBytes: 0`, `tcp-connected` and `connected` are emitted in that order at connect).
`timeoutMs` bounds the connect phase only. `headerTimeoutMs` bounds the header phase, counted from
`tcp-connected`; without it the hub waits for the header without limit (the parent decides).

`rcvBufBytes` requests the upstream socket's `SO_RCVBUF` **between `socket()` and `connect()`**,
so the window scale in the SYN covers it. An explicit `SO_RCVBUF` turns the kernel's receive
autotuning off for that socket (Linux `SOCK_RCVBUF_LOCK`, XNU `SB_USRSIZE`), so the hub sets it
only when the platform allows the whole request, and otherwise leaves autotuning alone:

- Linux: `/proc/sys/net/core/rmem_max` is read at the connect (never on the data path); the
  option is set only when `rmem_max` is at least the request (a larger request would be clamped
  to `rmem_max` silently and still lock the size). Linux then grants twice the request. The
  default `rmem_max` (212 992) allows none of the sizes below.
- macOS: the limit is `kern.ipc.maxsockbuf`; a request above it is not tried. Otherwise the
  option is set and read back; a refusal (`ENOBUFS`: XNU's own limit is
  `maxsockbuf x 2048 / 2304`) or a smaller grant closes that socket and makes a new one without
  the option, autotuning untouched.

`tcp-connected.rcvBuf` reports `{requested, granted, applied, limit}`: `granted` is
`getsockopt(SO_RCVBUF)` of the socket used (with `applied: false`, the kernel's default before
autotuning), `limit` the platform limit read (null when unknown). The request covers the hub's
own lateness, not the core's: `V = roundUp_MiB(2 x 1.2 s x byteRate)` (1.2 s is the worst
lateness measured for a thread that is not saturated), at most 32 MiB:

| Rate (CU8) | byteRate (B/s) | 2 x 1.2 s x byteRate | V                   | macOS, `maxsockbuf` 8 MiB | Linux, `rmem_max` 212 992 |
| ---------- | -------------- | -------------------- | ------------------- | ------------------------- | ------------------------- |
| 1.024 Msps | 2 048 000      | 4 915 200            | 5 MiB (5 242 880)   | applied                   | not applied               |
| 2.4 Msps   | 4 800 000      | 11 520 000           | 11 MiB (11 534 336) | not applied (autotune)    | not applied               |
| 3.2 Msps   | 6 400 000      | 15 360 000           | 15 MiB (15 728 640) | not applied (autotune)    | not applied               |

With `rmem_max` raised to 33 554 432 (32 MiB), every row is applied on Linux.
An attempt id must be greater than every id used before in this hub's life, which is stricter
than "never reused": an id below one used earlier is refused `attempt-reused` even if it was never
used itself. A refused `connect` does not use its id (it may be sent again once a place is free).

`adopt` makes the attempt the stream. A previously adopted attempt is closed first
(`closed {reason: "replaced"}` precedes `adopted`); its trailing partial frame is discarded.
The stream ordinal increases by one and the level's stride phase restarts.

`abort` closes an attempt in one of three modes:

- `"now"` (the default): at once; each pending command fails (`write-failed {reason: "closed"}`).
- `"after-writes"`: the hub stops reading the attempt at once (an adopted stream ends for the
  sinks exactly as on a peer close: they keep and drain what the ring holds), lets the pending
  commands complete (each is answered `written` as usual), then closes. No new `write` is accepted
  for the attempt (`write-failed {reason: "closing"}`).
- `"graceful"`: as `after-writes`, and once the pending commands are done the hub shuts the write
  side (`shutdown(SHUT_WR)`), then keeps reading and discarding input (never into the ring, never
  counted in `sourcePos` or `arrivals`) until the peer closes. It suits a peer that closes when
  it sees the half-close. Against a peer that keeps sending (an IQ server that ignores the FIN)
  the socket is readable for every arriving segment, so the hub wakes once per segment for up to
  `graceMs`; it never delays the adopted stream and never spins, but give such a peer a short
  `graceMs` or use `after-writes`.

Both waiting modes are bounded by `graceMs`: at the deadline whatever is still pending fails with
`write-failed {reason: "closed"}` and the socket closes. Once an attempt is closing, `graceMs` is
its only bound: a pending `headerTimeoutMs` no longer applies, so an attempt aborted in its header
phase closes at the end of its grace, never with `timeout`. A connecting attempt has written
nothing and has no connection to half-close, so every mode closes it at once; in the other phases
a waiting mode with nothing pending closes (`after-writes`) or shuts its write side (`graceful`)
at once. The answer is one `closed {reason: "aborted", mode}` when the socket is finally closed,
carrying the `abort`'s `seq`; it answers the `abort` even when a peer close, an error (with its
`errno`) or the deadline ends the grace. `phase` is the phase the attempt was aborted in. During
the grace a second `abort` with `mode: "now"` closes at once (the `closed` then carries that
`abort`'s `seq` and `mode: "now"`; one `closed` answers every `abort` of an attempt); any other
second `abort` is refused `closing`. A closing attempt still counts against the 4-attempt limit
and cannot be adopted (`closing`), but another attempt may be adopted while it closes, at once:
the closing attempt is no longer the stream, and its `closed` carries the head at the instant it
is emitted, as every event does, so `sourcePos` never goes back. The stream it carried ended
where it stopped reading: its `closed.sourcePos` when nothing was adopted in the grace, else the
next `adopted.sourcePos`, unless a `configure` with other values came during the grace: that
restarts the position grid (the old stream's sinks were already closed `reconfigured`), so the
`closed.sourcePos` is then on the new grid. A `written` answered during the grace has a null
`sourcePos` (its attempt is no longer the adopted one). A hub shutdown does not wait for a grace:
the hub exits, and as for every attempt no `closed` is emitted.

`write` writes a tuner command to a held or adopted attempt that has no front (one with a front
takes its commands from the front only: `write-failed {reason: "fronted"}`, so one writer
orders the stream). Commands of an attempt are never
reordered; a partial non-blocking write is completed before the next command; a command that
would make more than 64 commands or 4 096 bytes pending fails (`pending-limit`). A parent that
forwards a larger payload splits it into consecutive `write` requests, which the hub never
reorders. An attempt that closes answers each pending command with
`write-failed {reason: "closed"}`, so the 64 bound keeps that answer under 14 KiB of events (64
lines of at most 214 bytes).

`mark` answers with an exact "now" (see "Sink bytes" below). The marks owed to framed sinks are
kept once for all of them, at most 1 024 per sink: a skip drops the marks inside the skipped
range (they are not delivered in band to that sink; the gap record says their bytes are gone),
so a stalled sink owes only the marks of its live window. A sink that still owes 1 024 when a
`mark` arrives (1 024 marks inside its window) is first skipped to the live edge, one
`sink-gap {cause: "lag"}`: a stalled sink never makes another sink's `mark` fail. Marks at the
head cannot be skipped, so while a framed sink is active at most 1 024 marks may share one
`sourcePos`; the next is refused `too-many-marks` whatever the sinks do.

## Events

Every event is `{"v":1,"type":"<event>","mono":<ms>, ...}` and, once a ring is configured,
carries `sourcePos`: the head (whole-frame bytes appended so far) when the hub emitted it.
`mono` is the hub's monotonic clock in milliseconds since it started (microsecond resolution).
An answer carries its request's `seq`.

| Event           | Members                                                                                                                                                                                                             | When                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`         | `protocol` (1), `features`, `sinkSocket`, `maxSinks` (32), `maxAttempts` (4)                                                                                                                                        | first, once                                                                                                                                                                                                                                                                                                                              |
| `rejected`      | `request` (the request's type, or null), `reason`, [`detail`]                                                                                                                                                       | a refused request                                                                                                                                                                                                                                                                                                                        |
| `configured`    | `ringBytes`                                                                                                                                                                                                         | `configure`                                                                                                                                                                                                                                                                                                                              |
| `tcp-connected` | `attempt`, `localPort`, [`rcvBuf: {requested, granted, applied, limit}`] (with `rcvBufBytes`)                                                                                                                       | the TCP connection is up (`localPort` from `getsockname`), before any byte was read; `seq` is the `connect`'s                                                                                                                                                                                                                            |
| `connected`     | `attempt`, `headerHex`                                                                                                                                                                                              | the header was read (`""` for 0 bytes); right after `tcp-connected` for `headerBytes: 0`                                                                                                                                                                                                                                                 |
| `payload-ready` | `attempt`                                                                                                                                                                                                           | the first payload byte of a held attempt is readable (not consumed); once                                                                                                                                                                                                                                                                |
| `closed`        | `attempt`, `phase` (`connect`, `header`, `held`, `adopted`), `reason` (`timeout`, `refused`, `unreachable`, `reset`, `eof`, `aborted`, `replaced`, `error`), [`mode`], [`errno`], [`connectSeq`], [`front`], [`by`] | the attempt closed; for an adopted one `sourcePos` is where its stream ended (see `abort` for one adopted in a grace). `seq` and `mode` (`now`, `after-writes`, `graceful`) are the `abort`'s when it answers an `abort`; `errno` see below; `connectSeq` is the `connect`'s whenever that connect was never answered by `tcp-connected` |
| `adopted`       | `attempt`, `stream` (ordinal from 1)                                                                                                                                                                                | `adopt`; `sourcePos` is the new stream's first byte                                                                                                                                                                                                                                                                                      |
| `written`       | `id`, `attempt`; `sourcePos` the head when the command's last byte was accepted, or `null` when the attempt is not the adopted one                                                                                  | `write`                                                                                                                                                                                                                                                                                                                                  |
| `write-failed`  | `id`, `attempt`, `reason` (see "Reasons"), [`errno`]                                                                                                                                                                | `write`; pending commands of a closing attempt fail with `closed` before its `closed` (with that `closed`'s `errno`, when it has one)                                                                                                                                                                                                    |
| `marked`        | `id`, `sinks: [{sink, sinkByte}]`                                                                                                                                                                                   | `mark`: an exact "now"; every active sink's byte that `sourcePos` maps to                                                                                                                                                                                                                                                                |
| `progress`      | `stream` (or null between streams), `level: {count, sumSquares}` (or null), `arrivals: {reads, bytes, maxGapMs}`, `sinks: [{sink, sinkBytes, lagBytes, gaps, droppedBytes}]`                                        | every `progressMs` once a ring is configured, also between streams                                                                                                                                                                                                                                                                       |
| `link-gap`      | `startMono`, `endMono`, `queuedBytes`                                                                                                                                                                               | a gap of at least `linkGapMs` between two reads of the adopted stream                                                                                                                                                                                                                                                                    |
| `sink-ready`    | `sink`                                                                                                                                                                                                              | `sink-open`                                                                                                                                                                                                                                                                                                                              |
| `sink-bound`    | `sink`                                                                                                                                                                                                              | a hello bound a connection to the sink                                                                                                                                                                                                                                                                                                   |
| `sink-rejected` | `reason` (see "Reasons"), `sink` for `bound` only                                                                                                                                                                   | a connection was refused and closed; an undeclared id is never echoed                                                                                                                                                                                                                                                                    |
| `sink-started`  | `sink`, `startSourcePos` (the sink's first position), `sinkByte` (0); `sourcePos` is the head, as on every event                                                                                                    | `sink-activate`, or a front's start (F3)                                                                                                                                                                                                                                                                                                 |
| `sink-updated`  | `sink`                                                                                                                                                                                                              | `sink-update`                                                                                                                                                                                                                                                                                                                            |
| `sink-gap`      | `sink`, `atSinkByte`, `atSourcePos`, `droppedBytes`, `cause` (`lag`, `stream`, or `start` for a front)                                                                                                              | a sink skipped bytes                                                                                                                                                                                                                                                                                                                     |
| `sink-closed`   | `sink`, `reason` (`request`, `peer`, `reconfigured`, `attempt-closed`), `sinkBytes`; a front's also `headerSent`, `droppedBytes`, `discardedBytes`                                                                  | the sink is gone                                                                                                                                                                                                                                                                                                                         |
| `front-placed`  | `sink`, `frontBytes`, `atSourcePos`, `sinkByte`, `queuedBytes`                                                                                                                                                      | a front reached the position of the commands it sent upstream (see "Front sinks")                                                                                                                                                                                                                                                        |
| `front-ended`   | `sink`, `sinkBytes`, `headerSent`, `droppedBytes`, `discardedBytes`, `reason`, [`errno`]                                                                                                                            | a front has its whole stream (or what its EOF left of it) and its write side is shut                                                                                                                                                                                                                                                     |

### Reasons

| Event           | Reason              | When                                                                                                |
| --------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| `rejected`      | `malformed`         | not UTF-8, not a JSON object, a duplicate key, a missing or unknown member, a wrong type, `v` not 1 |
| `rejected`      | `bounds`            | a value out of its bound (the request tables above), or `maxLagMs` over `--ring-ms` / 2             |
| `rejected`      | `unknown-type`      | `type` names no request                                                                             |
| `rejected`      | `too-long`          | a line over 65 536 bytes with its newline (`request` null)                                          |
| `rejected`      | `no-memory`         | `configure`: the ring could not be allocated                                                        |
| `rejected`      | `attempt-reused`    | `connect`: the id is not above every id used before                                                 |
| `rejected`      | `too-many-attempts` | `connect`: 4 attempts are live                                                                      |
| `rejected`      | `unknown-attempt`   | `adopt`, `abort`: no live attempt has that id                                                       |
| `rejected`      | `closing`           | `adopt` of an attempt an `abort` is closing; `abort` other than `now` of one                        |
| `rejected`      | `not-ready`         | `adopt`: the attempt is still connecting or reading its header                                      |
| `rejected`      | `already-adopted`   | `adopt`: the attempt is the stream already                                                          |
| `rejected`      | `not-configured`    | `adopt`, `mark`, `sink-activate`: no ring yet                                                       |
| `rejected`      | `too-many-marks`    | `mark`: 1 024 marks at this `sourcePos` while a framed sink is active                               |
| `rejected`      | `sink-exists`       | `sink-open`: the id is declared                                                                     |
| `rejected`      | `unknown-attempt`   | `sink-open` of a front: no live attempt has that id                                                 |
| `rejected`      | `closing`           | `sink-open` of a front: an `abort` is closing the attempt                                           |
| `rejected`      | `front-exists`      | `sink-open` of a front: the attempt has (or had) a front                                            |
| `rejected`      | `front`             | `sink-activate` of a front (it starts with its attempt's stream)                                    |
| `rejected`      | `too-many-sinks`    | `sink-open`: 32 sinks are declared                                                                  |
| `rejected`      | `unknown-sink`      | `sink-activate`, `sink-update`, `sink-close`: no sink has that id                                   |
| `rejected`      | `not-bound`         | `sink-activate`: no connection has bound the sink                                                   |
| `rejected`      | `active`            | `sink-activate`: the sink is active already                                                         |
| `write-failed`  | `not-connected`     | the attempt is unknown, connecting or reading its header                                            |
| `write-failed`  | `pending-limit`     | 64 commands or 4 096 bytes would be pending                                                         |
| `write-failed`  | `closed`            | the attempt closed with the command pending                                                         |
| `write-failed`  | `closing`           | an `after-writes` or `graceful` `abort` is closing the attempt                                      |
| `write-failed`  | `fronted`           | the attempt has a front: its commands come from the front only                                      |
| `sink-closed`   | `attempt-closed`    | a front's attempt closed before the front started (F13)                                             |
| `front-ended`   | `front-closed`      | the front's EOF (its peer's `end()` or `destroy()`) cut its delivery                                |
| `front-ended`   | a `closed.reason`   | its stream ended: `eof`, `reset` (with `errno`), `error`, `aborted`, `replaced`, ...                |
| `closed`        | `by: "front"`       | (member) the `abort` was the hub's own, started by the attempt's front (F9, F10, F15, F16)          |
| `sink-rejected` | `hello-timeout`     | no complete hello within 10 s of the connection                                                     |
| `sink-rejected` | `too-many`          | the 9th connection waiting for its hello                                                            |
| `sink-rejected` | `unknown`           | the hello names no declared sink (the id is not echoed)                                             |
| `sink-rejected` | `bound`             | the hello names a sink that is bound or active                                                      |
| `sink-rejected` | `malformed`         | not a hello (or EOF before one)                                                                     |

`features` lists every optional capability: `mark`, `sink-update`, `link-gap`, `tcp-connected`
(the event, and the `connect`'s `seq` on it rather than on `connected`), `header-timeout`
(`headerTimeoutMs`, and `timeoutMs` bounding the connect phase only), `errno` (the member on
`closed` and `write-failed`), `close-modes` (`abort`'s `mode` and `graceMs`, `closed.mode`, the
`closing` reasons), `front` (front sinks: `sink-open {kind: "front", attempt}`, `front-placed`,
`front-ended`, the `fronted`, `front`, `attempt-closed` and `front-closed` reasons, `closed.front`
and `closed.by`), `rcvbuf` (`connect.rcvBufBytes`, `tcp-connected.rcvBuf`) and `stats-file`
(`--stats-file`). A parent sends a member or request only when its feature is listed, so
strict parsing does not break version skew, and reads an older binary's events by its list.

`errno` is the error number the operating system gave for a failed connect, read or write. It is
the platform's own (Linux and macOS number most errors differently: `ECONNREFUSED` is 111 on Linux,
61 on macOS); `reason` is the portable part. It is absent when there is none: end of file, a
timeout, an abort, a replacement.

`progress` counters are cumulative since `configure`. `level` is the figure the core's
`SignalLevelTracker.feed` computes: every `levelStride`-th component (`u8`: one byte,
`((raw - 127.5) / 127.5)^2`; `s16le`: two bytes, `(raw / 32768)^2`), positions kept across
reads. `arrivals.reads` and `arrivals.bytes` count successful reads of the adopted stream and
their bytes (partial frames included); `maxGapMs` is the longest gap between two of them.
`sinks` lists the active sinks: `sinkBytes` is the payload the kernel took, `lagBytes` is
`head - cursor`, `gaps` and `droppedBytes` count the skips that dropped bytes.

`link-gap`: one event per gap of at least `linkGapMs` between two successful reads of the
adopted stream, emitted with the read that ends it (`sourcePos` is the head before that read).
`queuedBytes` is `FIONREAD` just before that read: a large value means the bytes were waiting
and the host was late, a small one that the link delivered nothing. The reader's own wait (see
"Reading") is not a gap: the gap clock restarts when the wait is due.

**Sink bytes.** A sink's byte count (`sinkByte`, `atSinkByte`, `sinkBytes`) counts payload bytes
in the order the sink receives them. For a framed sink that is the records' payload, record
headers excluded, so the same arithmetic holds for both kinds. `marked.sinkByte` is the sink
byte at which `sourcePos` will be carried, given the gaps reported so far: a later `sink-gap`
before that position moves it back by its `droppedBytes` (or drops it, if the gap covers it).
A framed sink also gets the mark in band, as a type 4 record, which is always exact, unless the
mark lies inside a range the sink skipped (see "framed").

## Sinks

A sink is declared by `sink-open`, then bound by a connection to `DIR/hub.sock` whose first line
is the hello `{"v":1,"sink":"<id>"}` and a newline: at most 256 bytes with the newline, within
10 s of the connection, exactly these two members and no escapes. At most 8 connections may wait
for their hello. Connect only after `sink-ready`. After the hello the hub shuts the
connection's read side (`shutdown(SHUT_RD)`), polls it for writes and hang-ups only, and sets
its send buffer to about 50 ms of signal (`byteRate / 20` bytes; what the kernel grants is
logged at debug level). A child that writes into the connection cannot wake the hub. A hang-up
of an idle sink is noticed by Linux's `poll` at once; macOS reports none for a socket polled
with no events, so idle sinks are also probed after each `progress` and at least once a second
(a bound sink's hang-up before any `configure` is seen within a second).

`sink-activate` starts the sink at `atSourcePos` when that is on the frame grid and inside
`[max(streamStart, head - maxLagBytes + resumeBytes), head]`, where `streamStart` is the head at
the latest `adopt` (0 after a `configure`); otherwise (older, in an earlier stream, unaligned or
future) at the head. A sink never starts in an earlier stream, so it never crosses a stream
boundary without its `sink-gap {cause: "stream"}` and type 3 record. `sink-started` says where it
started (`startSourcePos`).

**raw** sinks receive payload bytes only, and a raw sink's byte count is always a multiple of
`frameBytes` at a gap. Gaps are reported out of band: `sink-gap {atSinkByte, atSourcePos,
droppedBytes, cause}`, where `atSinkByte` is the form `wavekit-chan`'s
`mark-gap {atInputByte, droppedInputBytes}` takes and `atSourcePos` is the first missing byte.
Cause `stream` is a new adopted stream: `droppedBytes` is what of the old stream the sink had not
been sent (possibly 0).

**framed** sinks receive records, little-endian, each with a 24-byte header:

| offset | field | type | value                           |
| ------ | ----- | ---- | ------------------------------- |
| 0      | magic | u16  | `0x4B57`                        |
| 2      | type  | u8   | 1 data, 2 gap, 3 stream, 4 mark |
| 3      | flags | u8   | 0                               |
| 4      | len   | u32  | payload bytes that follow       |
| 8      | pos   | u64  | see below                       |
| 16     | aux   | u64  | see below                       |

- type 1, data: `len` payload bytes (a multiple of `frameBytes`, at most 65 536), `pos` the
  `sourcePos` of the first, `aux` 0. A data record never spans a mark's position.
- type 2, gap: `len` 0, `pos` the first missing `sourcePos`, `aux` the missing bytes.
- type 3, stream: `len` 0, `pos` the `sourcePos` where the new stream starts, `aux` its ordinal.
- type 4, mark: `len` 0, `pos` the mark's `sourcePos`, `aux` the `mark` request's id. It comes
  just before the data at `pos`. A mark inside a range the sink skipped is not delivered in band
  (the gap record says those bytes are gone; `marked` still carries the mapping). A mark at the
  first position of a skipped range may already have gone out, or its record may have begun
  (it is then completed), before the skip: it then comes right before that gap's record.

The same gaps are also emitted as `sink-gap` events. A framed sink that is blocked across several
skips and adopts gets its in-band records merged: consecutive gaps become one gap record, and a
stream all of whose bytes were dropped is folded into the gap, so a blocked sink holds at most
three pending control records. Each skip still has its own `sink-gap` event, so a parent counting
events sees more gaps than the sink sees gap records, with the same total of dropped bytes.

**The unit in flight.** A raw sink's unit is one frame; a framed sink's is one record. Each sink
has a spill buffer of 65 536 + 24 bytes, allocated when it is declared. When the cursor must move
(a skip, an `adopt`) while the kernel has taken part of a unit, the unsent rest of that unit is
copied into the spill at once and the cursor moves to the unit's end; the spill is written before
anything else, and a gap's `atSinkByte` is the sink's byte count after the spill. So a record is
never cut and a raw stream never loses frame alignment. A data record the kernel has taken no
byte of is not in flight: it is dropped with the skip, and so is a mark record whose position
the skip drops. A gap or stream record is always delivered.

## Front sinks

A **front** stands in for the rtl_tcp endpoint itself, so a parent can keep a plain socket
where it had a TCP connection. It is bound to one attempt (`sink-open {kind: "front",
attempt}`, at most one front per attempt, for the attempt's life). Its connection carries:

- **out**: the attempt's header (its `headerBytes`, the **header unit**, sent before any
  payload byte, never cut and not counted in `sinkBytes`; `headerSent` counts it), then the
  attempt's stream, exactly as a raw sink: the same ring cursor, lag guard (`maxLagMs`,
  `resumeMs`), spill, `sink-gap {cause: "lag"}`, `marked` mapping and `progress.sinks[]` entry;
- **in**: the tuner commands. The read side is not shut. Every byte after the hello's newline
  (in the hello's own read too) is a command byte, sent upstream in order.

A fronted attempt **adopts itself when its header is complete** (or at once, when the front is
declared on an attempt already held), provided a ring is configured: the payload never waits in
the kernel for the parent's `adopt`. A previously adopted attempt is replaced as by `adopt`. The
front starts when it is bound and its attempt is the stream, whichever comes last; it needs no
`sink-activate` (refused `front`).

**Commands.** The bytes join the attempt's command queue as internal commands of at most 64
bytes; the unsent tail command is filled up to 64 bytes before a new one starts. No `written`
or `write-failed` answers them, and a control `write` to a fronted attempt fails `fronted`. The
**read gate G** is open while the front is active and its stream is not over (no end set, its
EOF not seen), its attempt is the adopted stream and not closing, no hello bytes wait, fewer
than 64 commands and 4 096 bytes are pending on the attempt (each read takes at most what both
bounds leave) and fewer than 256 placements are pending. While G is closed the front is not
polled for reading: the parent's bytes wait in its socket. (With the tail fill, 63 commands hold
at most 4 032 bytes, so the 64-command bound always closes G no later than the byte bound.) A
bound front whose stream has not started is read into the hello's 256-byte buffer only, so its
EOF in the attempt's header phase is seen.

**Placements.** Each time the attempt sends some of the front's command bytes, the hub records
one placement `(frontBytes, atSourcePos, queuedBytes)`: the front's command bytes sent so far,
the head then, and `FIONREAD` of the upstream socket then (IQ bytes already received but not
yet read, which were produced before the command arrived). Sends at one head share one
placement. When the front's cursor reaches `atSourcePos` (at once when it is at the head), the
hub emits `front-placed {sink, frontBytes, atSourcePos, sinkByte, queuedBytes}`, where
`sinkByte` is the front's sink byte that carries `atSourcePos`: every front byte before it was
in the ring before the command went upstream, and the first byte produced after the upstream
read the command is within `queuedBytes` plus the peer's own buffers after it. A placement inside
a lag skip gets that skip's `atSinkByte` (the skip is emitted first). At 256 pending placements
G closes (`commandGateStalls` counts the closures) and the attempt holds back the front's
queued commands until one resolves, so a placement never spans two positions. A command sent
after the front's stream ended is never placed (the front carries no byte after it), and when a
front ends or closes its pending placements are dropped: the parent resolves them as not placed.

**End.** A front has an `end`: its stream's end (`closed.sourcePos`, or the next
`adopted.sourcePos`), or the cursor at its own EOF. It is sent up to `end` (the lag guard still
applies, and never skips past `end`); then the hub shuts its write side and emits
`front-ended` with the reason. The bytes its EOF cut off are `discardedBytes` (a parent that
closes the front discards them by design: not loss). Its counts then satisfy, per front,

```
U = sinkBytes + droppedBytes + discardedBytes        U = end of stream - startSourcePos
```

A front closed before its `front-ended` (a failed write or a hang-up, F10; `configure` with
other values, F15; `sink-close`, F16) carries the same identity on its `sink-closed`: its stream
stops at the close, so U ends at the stream's end when it was already set, otherwise at the head
at the close (the event's `sourcePos`). What the ring held past the front's cursor, and the
spilled payload bytes the kernel never took, are in its `discardedBytes`.

The parent's own count N (payload bytes it read) gives the bytes it abandoned at its close as
`K = sinkBytes - N`; the hub cannot see them (macOS reports no unread count for a Unix-socket
sender: `SO_NWRITE` is 0), so the stats file keeps every closed front's final `sinkBytes`
(and `sinkBytesAtEof`) for that check. These identities catch unreported loss; positions are
proven by the stamped tests (`tests/process.rs`, below).

### Front states

`G` is the read gate above. A front's attempt is the one named at `sink-open`; "live" means not
closed, "closing" an `abort` waiting mode in progress.

| Row | State                   | Event                                                | Guard                                                | Next     | Action / emission                                                                                                                                                                                      |
| --- | ----------------------- | ---------------------------------------------------- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | (none)                  | `sink-open {kind: "front", attempt}`                 | attempt live, not closing, no front yet; sink bounds | declared | `sink-ready`; a held attempt adopts itself (`adopted`, no `seq`)                                                                                                                                       |
| F1r | (none)                  | same                                                 | otherwise                                            | (none)   | `rejected` (`sink-exists`, `bounds`, `too-many-sinks`, `unknown-attempt`, `closing`, `front-exists`)                                                                                                   |
| F2  | declared                | hello naming it                                      |                                                      | bound    | `sink-bound`; the read side stays open; the send buffer is set (50 ms); bytes after the newline wait in the front's 256-byte buffer for G                                                              |
| F3  | bound                   | its attempt adopted (or bound while it is)           | stream start >= head - maxLagBytes + resumeBytes     | active   | cursor = stream start; the header unit queued; `sink-started {startSourcePos: stream start, sinkByte: 0}`                                                                                              |
| F3g | bound                   | same                                                 | the stream start is older                            | active   | `sink-started` as F3, then `sink-gap {cause: "start", atSinkByte: 0, atSourcePos: stream start, droppedBytes}`; cursor = align_down(head - resumeBytes)                                                |
| F4  | declared, bound, active | `sink-activate`                                      |                                                      | same     | `rejected {reason: "front"}`                                                                                                                                                                           |
| F5  | active                  | head advanced or writable                            | header unit unsent                                   | active   | send the header unit first (never cut)                                                                                                                                                                 |
| F6  | active                  | head advanced or writable                            | spill empty, `0 < lag <= maxLagBytes`                | active   | raw write, up to `end` when set                                                                                                                                                                        |
| F7  | active                  | head advanced or writable                            | `lag > maxLagBytes`                                  | active   | raw skip to align_down(head - resumeBytes), never past `end`; `sink-gap {cause: "lag"}`                                                                                                                |
| F8  | active                  | readable                                             | G open                                               | active   | read at most what the command bounds admit; append (tail fill); send upstream                                                                                                                          |
| F8s | (attempt)               | some of the front's command bytes sent               |                                                      |          | one placement `(frontBytes, head, FIONREAD)` (coalesced at one head)                                                                                                                                   |
| F8p | active                  | after a write, a skip, or a placement at the cursor  | placement `atSourcePos <= cursor`                    | active   | `front-placed` in order (inside a skip: its `atSinkByte`)                                                                                                                                              |
| F8f | active                  | 256 placements pending                               |                                                      | active   | G closes, `commandGateStalls` + 1 once per closure; the attempt holds the front's queued commands back                                                                                                 |
| F9  | bound, active           | EOF or read error on the front                       |                                                      | same     | `end` = the cursor (if earlier); a live attempt not closing gets an internal `abort {mode: graceful, graceMs: 2000}` (its `closed` has `by: "front"`); F12 when nothing is in flight                   |
| F10 | bound, active           | write `EPIPE`, reset, hang-up (not polled to read)   |                                                      | (none)   | `sink-closed {reason: "peer"}`; internal graceful abort as F9; pending placements dropped                                                                                                              |
| F11 | active                  | its stream ends (peer close, error, abort, replaced) |                                                      | active   | `end` = the stream's end; delivery continues to `end`                                                                                                                                                  |
| F12 | active, end set         | cursor = end, spill and header unit empty            |                                                      | ending   | `front-ended {reason}` (the stream's close reason and `errno`, or `front-closed` when F9 set the end); `shutdown(SHUT_WR)`; a front whose EOF was seen closes at once (`sink-closed {reason: "peer"}`) |
| F13 | declared, bound         | its attempt closes                                   |                                                      | (none)   | after the attempt's `closed`: `sink-closed {reason: "attempt-closed"}`                                                                                                                                 |
| F14 | ending                  | EOF, read error or hang-up                           |                                                      | (none)   | `sink-closed {reason: "peer", sinkBytes}` (input while ending is read and discarded)                                                                                                                   |
| F15 | bound, active, ending   | `configure` with other values                        |                                                      | (none)   | `sink-closed {reason: "reconfigured"}`; a live attempt not closing gets an internal graceful abort (its pending commands still go upstream; one closing keeps its grace)                               |
| F16 | any                     | `sink-close`                                         |                                                      | (none)   | `sink-closed {reason: "request"}`; internal graceful abort as F15                                                                                                                                      |
| F17 | any                     | hub shutdown                                         |                                                      | (none)   | close (no events)                                                                                                                                                                                      |
| F18 | active                  | `mark`                                               |                                                      | active   | `marked.sinks[]` includes the front (raw mapping)                                                                                                                                                      |

Attempt side: `closed` of a fronted attempt carries `front` (the front's id, also after the
front closed), and `by: "front"` when the hub's own abort closed it. A front's commands that an
attempt fails (its close, its grace's end) are dropped without `write-failed`. A front's EOF
while its stream drains (the stream ended first) ends the front at once with the stream's
reason, its rest discarded. The macOS `poll` reports a half-close as `POLLIN | POLLHUP`: a front
polled for reading reads to its EOF before anything else.

A front is sent to at its start (F3, F3g) and when its stream ends, not only on a head advance
or writable: a front bound after its stream's last read, or one whose stream ends with nothing
more to read, still sends its header unit and what the ring holds, then ends (F12). This kick
runs once the I/O loop has applied the actions (the front's connection is in place) and only for
the fronts that started or ended; a writable front is never polled for POLLOUT.

## Stats file

With `--stats-file PATH` the hub appends one line a second, and one at exit:

```
{"v":1,"type":"stats","utcMs","mono","pid","sourcePos","stream","memory":{"ringBytes","spillBytes"},
 "arrivals":{"reads","bytes","maxGapMs"},"sinks":[...],"closedFronts":[...],
 "linkGaps":{"count","maxMs","maxQueuedBytes"},
 "rusage":{"userUs","sysUs","nvcsw","nivcsw","maxRssBytes"},"statsSkipped"}
```

`utcMs` is the wall clock (to match lines with other logs), `mono` the hub's clock, `pid` the
hub's process id (a respawned hub shows a new one). Each entry of `sinks` (every declared sink)
and of `closedFronts` (the last 4 fronts that closed, with `closeReason`) has `sink`, `kind`,
`state` (`declared`, `bound`, `active`, `ending`, `closed`), `startSourcePos`, `sinkBytes`,
`headerSent`, `lagBytes`, `gaps`, `droppedBytes`, `discardedBytes`, `commandBytesIn`,
`commandBytesSent`, `placementsPending`, `commandGateStalls` and `sinkBytesAtEof`; a front's also
`attempt`. `memory.ringBytes` is the ring (57 600 000 B at 2.4 Msps with `--ring-ms 12000`,
allocated for the hub's life once configured) and `spillBytes` the sinks' spill buffers
(65 560 B each). `maxRssBytes` is `ru_maxrss` in bytes (Linux reports KiB, macOS bytes).

A write to a regular file can block (a slow or full disk; `O_NONBLOCK` does nothing for one), so
the loop never writes the file: it builds the line (at most about 16 KiB; no allocation once
warm) and hands it to one writer thread through a slot it only `try_lock`s. When the writer
still holds the slot (a write in progress) or has not taken the previous line, that second's
line is skipped and counted (`statsSkipped`), never waited for. The writer touches nothing but
the file and the slot. A failed write is logged once and the file is dropped. At exit the last
line waits at most 500 ms for the writer, then the hub exits anyway.

## State tables

`lag = head - cursor`. `maxLagBytes` and `resumeBytes` are the sink's milliseconds at the
configured rate, rounded down to `frameBytes`, computed at activation (and by `sink-update`).

### Sink states

| State                   | Event                                | Guard                                  | Next     | Action                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------ | -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (none)                  | `sink-open`                          | id unused, under 32 sinks, bounds hold | declared | emit `sink-ready`                                                                                                                                                                                               |
| (none)                  | `sink-open`                          | otherwise                              | (none)   | `rejected` (`sink-exists`, `too-many-sinks`, `bounds`)                                                                                                                                                          |
| (none)                  | any other sink request               |                                        | (none)   | `rejected {reason: "unknown-sink"}`                                                                                                                                                                             |
| declared                | hello naming it                      |                                        | bound    | emit `sink-bound`; shut the read side; set the send buffer (at activation if no ring yet)                                                                                                                       |
| bound, active           | hello naming it                      |                                        | same     | close the new connection, `sink-rejected {reason: "bound"}`                                                                                                                                                     |
| declared                | `sink-activate`                      |                                        | declared | `rejected {reason: "not-bound"}`                                                                                                                                                                                |
| bound                   | `sink-activate`                      | ring configured                        | active   | set the cursor, emit `sink-started`                                                                                                                                                                             |
| bound                   | `sink-activate`                      | no ring                                | bound    | `rejected {reason: "not-configured"}`                                                                                                                                                                           |
| active                  | `sink-activate`                      |                                        | active   | `rejected {reason: "active"}`                                                                                                                                                                                   |
| declared, bound, active | `sink-update`                        | bounds hold                            | same     | store, emit `sink-updated` (else `rejected`); used from the next guard evaluation                                                                                                                               |
| active                  | head advanced or writable            | spill not empty                        | active   | write the spill first                                                                                                                                                                                           |
| active                  | head advanced or writable            | spill empty, `0 < lag <= maxLagBytes`  | active   | non-blocking write from the ring, never across the wrap in one iovec; advance the cursor by what the kernel took; framed: whole records, header then payload                                                    |
| active                  | head advanced or writable            | `lag > maxLagBytes`                    | active   | move the unit in flight to the spill; cursor = align_down(head - resumeBytes); one `sink-gap {cause: "lag"}`; framed: a gap record precedes the next data                                                       |
| active                  | write would block                    |                                        | active   | wait for writable; nothing is dropped yet                                                                                                                                                                       |
| active                  | `adopt` of a new stream              |                                        | active   | move the unit in flight to the spill; one `sink-gap {cause: "stream"}` with the old stream's unsent bytes; framed: a gap record if any were dropped, then a stream record; cursor = the new stream's first byte |
| bound, active           | `configure` with other values        |                                        | (none)   | close, `sink-closed {reason: "reconfigured"}`                                                                                                                                                                   |
| declared                | `configure` with other values        |                                        | declared | its marks are computed at activation                                                                                                                                                                            |
| bound, active           | peer closed, `EPIPE`, reset, hang-up |                                        | (none)   | `sink-closed {reason: "peer"}`; no other sink is touched                                                                                                                                                        |
| declared, bound, active | `sink-close`                         |                                        | (none)   | close, `sink-closed {reason: "request"}`                                                                                                                                                                        |
| any                     | hub shutdown                         |                                        | (none)   | close                                                                                                                                                                                                           |

A connection that sends no complete hello within 10 s is closed with
`sink-rejected {reason: "hello-timeout"}` (a hello at exactly 10 s binds); the 9th waiting
connection with `too-many`; a hello for an undeclared sink with `unknown`; anything that is not
a hello (or EOF before one) with `malformed`. No `sink-gap` or `sink-started` for an id follows
its `sink-closed`. A blocked sink is not sent to on a head advance: only its guard runs.

### Attempt states

| State                                  | Event                                               | Guard                                         | Next                        | Action                                                                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------- | --------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (none)                                 | `connect`                                           | under 4 live attempts, id above every id used | connecting                  | start the non-blocking connect, arm `timeoutMs`                                                                                                                                               |
| (none)                                 | `connect`                                           | otherwise                                     | (none)                      | `rejected` (`too-many-attempts`, `attempt-reused`)                                                                                                                                            |
| connecting                             | TCP connected                                       | `headerBytes` > 0                             | header                      | emit `tcp-connected`; arm `headerTimeoutMs` if given; read up to `headerBytes`                                                                                                                |
| connecting                             | TCP connected                                       | `headerBytes` = 0                             | held                        | emit `tcp-connected`, then `connected`                                                                                                                                                        |
| connecting                             | connect failed, or its local port could not be read |                                               | (none)                      | `closed {phase: "connect"}` with the reason its `errno` maps to (`refused`, `unreachable`, `timeout`, `reset`, else `error`) and that `errno`; an unknown address family: `error` without one |
| connecting                             | `timeoutMs` passed                                  |                                               | (none)                      | close, `closed {reason: "timeout"}`                                                                                                                                                           |
| header                                 | `headerTimeoutMs` passed                            | the member was given                          | (none)                      | close, `closed {reason: "timeout"}`; without it the header has no deadline                                                                                                                    |
| header                                 | header complete                                     |                                               | held                        | emit `connected`; stop reading                                                                                                                                                                |
| held                                   | first payload byte readable                         | not yet reported                              | held                        | emit `payload-ready` once, then stop polling it for reading                                                                                                                                   |
| held                                   | `adopt`                                             | ring configured                               | adopted                     | close any adopted attempt (`closed {reason: "replaced"}` first); ordinal + 1; emit `adopted`; read into the ring; every active sink takes its `adopt` row                                     |
| held                                   | `adopt`                                             | no ring                                       | held                        | `rejected {reason: "not-configured"}`                                                                                                                                                         |
| (none), connecting, header, adopted    | `adopt`                                             |                                               | same                        | `rejected` (`unknown-attempt`, `not-ready`, `already-adopted`)                                                                                                                                |
| adopted                                | payload read                                        |                                               | adopted                     | append whole frames to the ring, advance the head, serve the sinks                                                                                                                            |
| held, adopted                          | `write`                                             |                                               | same                        | queue and send in order                                                                                                                                                                       |
| (none), connecting, header             | `write`                                             |                                               | same                        | `write-failed {reason: "not-connected"}`                                                                                                                                                      |
| connecting, header, held, adopted      | `abort` `now`                                       |                                               | (none)                      | fail pending writes, close, `closed {reason: "aborted", mode: "now"}`                                                                                                                         |
| connecting                             | `abort` `after-writes`, `graceful`                  |                                               | (none)                      | close, `closed {reason: "aborted"}` with the mode                                                                                                                                             |
| header, held, adopted                  | `abort` `after-writes`                              | commands pending                              | closing-after-writes        | stop reading (an adopted stream ends: its sinks keep what the ring holds); arm `graceMs`                                                                                                      |
| header, held, adopted                  | `abort` `after-writes`                              | nothing pending                               | (none)                      | stop reading, close, `closed {reason: "aborted", mode: "after-writes"}`                                                                                                                       |
| header, held, adopted                  | `abort` `graceful`                                  | commands pending                              | closing-graceful            | stop reading (as above); arm `graceMs`                                                                                                                                                        |
| header, held, adopted                  | `abort` `graceful`                                  | nothing pending                               | closing-graceful (draining) | stop reading (as above); arm `graceMs`; shut the write side                                                                                                                                   |
| connecting, header, held, adopted      | peer closed or error                                |                                               | (none)                      | fail pending writes, `closed` with phase, reason and `errno`; an adopted stream's sinks keep what the ring holds and drain it                                                                 |
| closing-after-writes, closing-graceful | payload readable                                    | not draining                                  | same                        | ignored (not polled for reading)                                                                                                                                                              |
| closing-after-writes, closing-graceful | writable                                            | commands pending                              | same                        | send in order; each command done is answered `written` (`sourcePos` null)                                                                                                                     |
| closing-after-writes                   | writable                                            | the last command done                         | (none)                      | close, `closed {reason: "aborted", mode: "after-writes"}`                                                                                                                                     |
| closing-graceful                       | writable                                            | the last command done                         | closing-graceful (draining) | shut the write side (`shutdown(SHUT_WR)`); poll for reading only                                                                                                                              |
| closing-graceful (draining)            | payload readable                                    |                                               | same                        | read and discard, at most 16 reads of 16 KiB per readiness                                                                                                                                    |
| closing-graceful (draining)            | peer closed                                         |                                               | (none)                      | close, `closed {reason: "aborted", mode: "graceful"}`                                                                                                                                         |
| closing-after-writes, closing-graceful | error                                               |                                               | (none)                      | fail pending writes (with `errno`), close, `closed {reason: "aborted"}` with the mode and `errno`                                                                                             |
| closing-after-writes, closing-graceful | `graceMs` passed                                    |                                               | (none)                      | fail pending writes, close, `closed {reason: "aborted"}` with the mode                                                                                                                        |
| closing-after-writes, closing-graceful | `write`                                             |                                               | same                        | `write-failed {reason: "closing"}`                                                                                                                                                            |
| closing-after-writes, closing-graceful | `abort` `now`                                       |                                               | (none)                      | fail pending writes, close, `closed {reason: "aborted", mode: "now"}` with this `abort`'s `seq`                                                                                               |
| closing-after-writes, closing-graceful | `abort` other mode                                  |                                               | same                        | `rejected {reason: "closing"}`                                                                                                                                                                |
| closing-after-writes, closing-graceful | `adopt` of it                                       |                                               | same                        | `rejected {reason: "closing"}`                                                                                                                                                                |
| closing-after-writes, closing-graceful | `adopt` of another attempt                          |                                               | same                        | that attempt is adopted at once (no `replaced`: this one is no longer the stream)                                                                                                             |
| closing-after-writes, closing-graceful | `mark`                                              |                                               | same                        | answered as usual (this attempt carries no stream)                                                                                                                                            |
| closing-after-writes, closing-graceful | `configure` with other values                       |                                               | same                        | the closing attempt is untouched (same grace, same pending commands); bound and active sinks close `reconfigured` (their own row)                                                             |
| any                                    | hub shutdown                                        |                                               | (none)                      | the process exits; no `closed`                                                                                                                                                                |

A peer close behind unread payload of a held attempt is seen only after adoption. When the
adopted stream ends, its trailing partial frame is discarded, the sinks stay and drain the ring,
and there is no stream until the next `adopt`.

## Reading

The ring holds `ringBytes`, a multiple of `frameBytes`; byte `p` lives at `p % ringBytes`. The
head moves by whole frames only: a read's trailing partial frame (at most `frameBytes - 1`
bytes) waits outside the ring until the rest arrives. One read takes at most `ringBytes / 4`
bytes; at the wrap it fills both sides in one `readv`, so the wrap never costs an extra read.

While data flows the reader paces itself by timer, one wake-up per block time. The block target
is `min(32 768 bytes, 20 ms of signal)` at the configured `byteRate`, and the block time is the
target's time at that rate. No byte count is carried from one read to the next:

- A read that fills its slot (`ringBytes / 4`: a backlog) is followed at once by another, so a
  backlog drains at full speed.
- Any other read that returns data drained the kernel (a receive returns everything queued, up
  to the buffer). The source stays out of the poll set and the next read is due one whole block
  time later (at most 20 ms), whatever this read took. So each timed read takes about one block,
  give or take one TCP segment (a 32 768-byte block is not a multiple of a 1 448-byte segment),
  a steady source costs one read and one timer wake-up per block time, and the fd is not polled
  in between. A source slower than `byteRate` still costs one read per block time, each taking
  less.
- Only a read that returns nothing puts the source back in the poll set for POLLIN: the source
  is idle or stalled. Its next data costs one readiness wake-up, then timed reads resume.

The added latency for a byte is at most the block time, plus however late the host wakes the
thread: 32 768 B at 2 048 000 B/s (1.024 Msps CU8) is 16 ms, at 4 800 000 B/s (2.4 Msps)
6.83 ms, and below 1 638 400 B/s (819.2 ksps) the 20 ms of signal is the smaller target, so the
wait is at most 20 ms. The loop rounds its `poll` timeout up to whole milliseconds (so it never
wakes before a deadline), which adds under 1 ms: as run, the bound is the block time + 999 us
(16.999 ms, 7.826 ms, 20.999 ms). A peer close or a socket error is seen by the next timed read,
within that time. The reader's own wait is never a `link-gap`: the gap clock restarts when the
wait is due.

## Limits and their arithmetic

- **Ring validity.** A sink's lag is at most `maxLagBytes <= ringBytes / 2` after every guard
  evaluation (the guard runs for every active sink after every read), and one read is at most
  `ringBytes / 4`. A read overwrites only positions below `head - ringBytes + ringBytes / 4`, so
  every unsent byte of every sink (at or after its cursor, at least `head - ringBytes / 2`) is
  still in the ring when the next guard moves it to the spill.
- **Spill.** One unit: at most a 24-byte header and 65 536 bytes of payload.
- **Pending control records** of a blocked framed sink: at most 3 (see "framed").
- **Marks:** at most 1 024 owed per framed sink (a sink that owes 1 024 skips to the live edge),
  kept once for all sinks: at most 1 024 x 24 bytes. At most 1 024 marks at one `sourcePos`
  while a framed sink is active.
- **Commands:** at most 64 bytes each, 64 commands and 4 096 bytes pending per attempt.
- **Timeouts:** `timeoutMs` and `headerTimeoutMs` 1 to 600 000 ms; a close's grace (`graceMs`)
  1 to 60 000 ms, 2 000 by default. Each is due exactly at its bound (`now >= start + ms x 1000`,
  microseconds of the hub's clock).
- **Graceful drain:** at most 16 reads into one 16 KiB buffer per readiness, 256 KiB discarded
  per wake-up; `poll` is level-triggered, so the rest waits for the next wake-up, and the grace
  bounds the whole drain.
- **Control input** is not read while more than 128 KiB of events are queued.
- **Listener:** after an accept error that its readiness does not clear (`EMFILE`, `ENFILE`,
  `ENOBUFS`, `ENOMEM` or any error not known to clear), it leaves the poll set for 100 ms, so a
  listener that stays readable cannot spin the loop.
- **Events:** 256 KiB queued; a line is built in a reserved 16 KiB buffer (the largest steady
  line, `progress` with 32 sinks, is under 7 KiB).
- **Positions** are `u64` bytes: at the largest rate, 64 MB/s, they overflow after
  2^64 / 64e6 s, about 9 000 years.
- **Clock:** `mono` is a `u64` of microseconds, good for 584 000 years.
- 32 sinks, 4 live attempts, 8 connections waiting for a hello, a 10 s hello deadline, hellos
  of at most 256 bytes and control lines of at most 65 536 bytes.
- **Fronts:** one per attempt; 256 placements pending each (at 256 G closes and the front's
  queued commands wait); hello bytes buffered before the start: 255 at most (256 with the
  hello, which is at least 19); a graceful close they start has a 2 000 ms grace. The core's
  sizing at 2.4 Msps (4 800 000 B/s), 1.024 Msps (2 048 000 B/s) and 3.2 Msps (6 400 000 B/s):
  `--ring-ms 12000` is 57 600 000, 24 576 000 and 76 800 000 B; `maxLagMs 6000` (at most
  `--ring-ms` / 2) is 28 800 000, 12 288 000 and 38 400 000 B; `resumeMs 250` is 1 200 000,
  512 000 and 1 600 000 B; the 50 ms send buffer 240 000, 102 400 and 320 000 B. Each
  `front-placed` line is under 200 bytes, so 256 of them are under 52 KiB of events.
- **Stats file:** one line a second (under 16 KiB: 32 sinks and 4 closed fronts of about 420
  bytes), written by its own thread; a busy second is skipped, never waited for.

## Tests and bench

```
make hub-test   # cargo test --release --locked --manifest-path native/wavekit-iqhub/Cargo.toml
make hub-build
cargo run --release --locked --example hub_bench --manifest-path native/wavekit-iqhub/Cargo.toml -- --rate 2400000 --seconds 15 --header
```

- `tests/front_table.rs`: one test per row of "Front states" (named after it: `f1_...` to
  `f18_...`, `a1_...` to `a4_...`, `m3_...`, `m6_...`), each bound at and past it: `maxLagMs`
  6 000 accepted and 6 001 refused with `--ring-ms 12000`, `resumeMs` 20 and 19; lag at
  `maxLagBytes` writes and one frame more skips; the F3 window edge and two bytes older; 63
  commands read and 64 not, the 65-byte room after a 63-byte tail, 255 placements read and 256
  closing the gate once; hello trailing bytes 0, 1 and 237 (256 with the hello); the tail fill
  (5 + 60 = 64 + 1; 4 096 bytes = 64 commands); placements at the head, after a lag of L bytes,
  inside a skip and at a skip's first byte; F9 in the header, held and adopted phases with 0, 1,
  63 and 64 commands pending; the grace's end at exactly 2 000 ms; a stream that ends with the
  front 0, 1 frame and `maxLagBytes` behind.
- `tests/sink_table.rs`, `tests/attempt_table.rs`: one test per row of the two tables above
  (named after the row), each guard at and past its bound, on a simulated kernel: the connect
  and header deadlines exactly at the bound and one microsecond before, no header deadline
  without `headerTimeoutMs`, `errno` on connect, read and write failures, and each close mode
  with its grace deadline at `graceMs` 1, 60 000 and the default (a header deadline that falls
  inside the grace does not apply).
- `tests/properties.rs`: property tests (256 cases each) over random source chunkings (splits
  inside frames), sink readiness and partial writes, and interleavings of `adopt`, stream ends,
  `mark` (with framed sinks stalled too), `write`, `sink-update`, `configure` in mid-stream
  (other values, a new `frameBytes` too, with sinks reopened afterwards) and `sink-activate` at
  any `atSourcePos`, and `abort` of the stream in each mode with partial command writes pending
  (input offered to the closing attempt, its peer closing, its grace running out): raw and
  framed sinks reconstruct the source exactly with their gaps and marks; a sink that never reads
  costs the others nothing; `written`, `marked` and start positions are exact; gaps stay on the
  frame grid; events stay in action order; the appended bytes stop exactly at an abort, and
  nothing a graceful drain reads reaches a sink or `sourcePos`; every accepted `write` is
  answered exactly once, in order, before its attempt's `closed`. A coverage test proves the
  generator reaches each of these. Front properties (256 cases each), over random chunking of
  the source and of the front's command writes, random front room and partial writes, random
  upstream command room, the front's EOF and the stream's end at random times and the clock
  running into the grace: the front's bytes are the header and the stream with its gaps
  re-inserted, and `startSourcePos + sinkBytes + droppedBytes + discardedBytes` is the stream's
  end (I-S3), or on the `sink-closed` of a front closed before its end the head at the close,
  with its unsent spill in `discardedBytes`; the upstream's commands are a prefix of the front's, all of them unless the
  attempt closed with commands unsent (I-C); every `front-placed` names the head when the
  upstream accepted its last byte and its `sinkByte` carries that position (I-P); a front that
  never reads costs the raw sink beside it nothing; `frontBytes` strictly increases.
- `tests/reader_pacing.rs`: the reader on a driven clock: a steady source costs one read and
  one wake-up per block time (1 000 block times: at most 1 001, no empty read), smooth, in
  16 KiB writes, in 1 448-byte TCP segments, with ±300 us of seeded jitter and at half the
  configured rate; a burst larger than the slot drains without waiting; a source that stops
  costs one empty read, then returns to the poll set and resumes with one readiness wake-up; no
  byte waits past the block time, or past the block time + 999 us with the loop's rounded poll
  timeout.
- `tests/control_parser.rs`: every request's missing and extra members, bounds (`headerTimeoutMs`
  and `graceMs` at and past each), `abort`'s `mode` (an unknown one refused, `graceMs` only with a
  waiting mode), `seq`, the line limit.
- `tests/allocations.rs`: a counting allocator proves the data path allocates nothing once warm
  (5 000+ blocks through 6 sinks with partial writes, skips, spills and `progress`; and 5 000+
  blocks through a front with command traffic: reads, tail fill, partial upstream sends,
  placements, `front-placed`, lag skips).
- `tests/process.rs`: the real binary with a loopback `TcpListener` as the source and Unix-socket
  sinks: a whole session (a child process reads a framed sink as its stdin), hello rejections,
  a closed sink and SIGPIPE, a child writing into its stdin, a parent that never reads stdout,
  a burst of 20 000 control lines, a bound sink's hang-up before any `configure`, a missing
  control fd, stdout and stderr closed by the parent, the directory checks and the 103-byte
  path limit; `tcp-connected` before any header byte with the `localPort` the listener sees; a
  header that never comes closing only with `headerTimeoutMs`; a graceful abort whose peer reads
  the last command and sees the half-close before the hub's `closed`; an after-writes abort that
  delivers the commands still pending when it was read; `errno` on a refused connect. Fronts
  against a **stamped** endpoint (every IQ byte is the count of command bytes it had read when
  it produced it): the header unit, the self-adoption, every command byte upstream in order
  (hello bytes included), and for every `front-placed` no byte before `sinkByte` carrying the
  new stamp and the first one within `queuedBytes` + the endpoint's send buffer + two writes;
  the same with the reader stopped 800 ms past `maxLagMs` (placements inside the skip at its
  `atSinkByte`); a stream ended by the endpoint delivered whole (its half frame discarded),
  `front-ended {reason: "eof"}`, the front's EOF, then `sink-closed`; `rcvBuf` at 64 KiB and
  64 MiB; the stats file's lines, `pid` and the closed front's final counts; a `write` refused
  `fronted`; a `--stats-file` that cannot be opened failing start-up.

`examples/hub_bench.rs` paces synthetic CU8 from an in-process TCP source into six sinks
(three raw readers at full speed, one stopped for 300 ms every second, one never read, one
framed) and prints one Markdown table row per run: the hub's CPU per second of IQ, context
switches per second, wake-ups per block and per read, reads per second, the granted send
buffer, per-sink bytes, gaps and dropped bytes, and the load average. For scale: reading 4.8 MB/s and writing it to 5 sinks is
about 29 MB/s of kernel copies.

`--one raw` and `--one front` run the bench with one sink of that kind (the front with a
5-byte command every 50 ms), one row each, to compare the front's CPU per second of IQ with a
raw sink's.

Build-only Linux branches (`src/sys.rs`): `MSG_NOSIGNAL`, `TCP_KEEPIDLE`, the
`/proc/sys/net/core/rmem_max` reader behind the `SO_RCVBUF` limit, and `ru_maxrss` read in
KiB (×1024 to bytes; macOS reports bytes).

Dependencies: `libc`, `serde` (without its `derive` feature: the two `Deserialize` impls are
written by hand) and `serde_json`; no procedural macro is built for the binary. See
`LICENSES.md`.
