# Adding Decoders to WaveKit

This guide explains how to add new signal decoders to WaveKit.

## Decoder Integration Patterns

Every decoder extends one of five bases in `src/decoders/`. Read the base you extend for its
required hooks before you start.

| Base                                                     | What the decoder receives                                | Built-in examples                               |
| -------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| `AudioDemodDecoder` (`audio-demod-decoder.ts`)           | Demodulated audio on stdin, from a channel WaveKit tunes | dsd-fme, multimon-ng, acarsdec, direwolf        |
| `IqDecimateDecoder` (`iq-decimate-decoder.ts`)           | Decimated IQ for its band, cut from the shared stream    | AIS-catcher, rtl_433, dumpvdl2, lora-meshtastic |
| `NetworkProducerDecoder` (`network-producer-decoder.ts`) | Runs as a service and publishes on a network port        | readsb                                          |
| `ExternalSdrDecoder` (`external-sdr-decoder.ts`)         | Opens its own SDR hardware                               | none built in                                   |
| `BaseDecoder` (`base-decoder.ts`)                        | Raw stdin; the common lifecycle the others build on      | (base of all of the above)                      |

The three walkthroughs below show the older, simpler patterns (pure consumer, network producer,
external SDR). New decoders that share the receiver should normally use `AudioDemodDecoder` or
`IqDecimateDecoder`; model them on the built-ins in `src/decoders/builtin/`.

Choose the pattern that matches how your decoder works.

## Pattern 1: Pure Consumer

For decoders that read audio from stdin and output to stdout.

### Step 1: Create the Decoder Class

Create `src/decoders/builtin/my-decoder.ts`:

```typescript
import { BaseDecoder } from "../base-decoder.js"
import type { DecoderConfig, DecoderOutput, DecoderCaps } from "../types.js"
import type { Logger } from "pino"

export const MY_DECODER_CAPS: DecoderCaps = {
	input: "audio_pcm",
	output: "jsonl",
	wantsExclusiveSource: false,
	wantsExclusiveSource: false,
	preferredSampleRates: [48000], // Warn if source rate changes to something else
	integrationPattern: "pure_consumer",
}

interface MyDecoderOptions {
	mode?: "auto" | "mode1" | "mode2"
	verbosity?: number
}

export class MyDecoder extends BaseDecoder {
	protected program = "my-decoder"
	protected args: string[] = []

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)

		const options = config.options as MyDecoderOptions

		// Build command line arguments
		this.args = ["-i", "stdin", "-o", "stdout"]

		if (options.mode && options.mode !== "auto") {
			this.args.push("-m", options.mode)
		}

		if (options.verbosity) {
			this.args.push("-v", String(options.verbosity))
		}
	}

	protected parseOutput(line: string): DecoderOutput | null {
		// Skip empty lines
		if (!line.trim()) return null

		// Try to parse JSON output
		try {
			const data = JSON.parse(line)
			return {
				timestamp: new Date(),
				decoder: this.id,
				type: "signal",
				data,
			}
		} catch {
			// Not JSON, try regex patterns
		}

		// Example: parse "SIGNAL: type=foo value=123"
		const match = line.match(/^SIGNAL:\s+type=(\w+)\s+value=(\d+)/)
		if (match) {
			return {
				timestamp: new Date(),
				decoder: this.id,
				type: "signal",
				data: {
					signalType: match[1],
					value: parseInt(match[2], 10),
				},
			}
		}

		// Unknown format, log as raw
		this.logger.debug({ line }, "Unparsed decoder output")
		return null
	}

	getCaps(): DecoderCaps {
		return MY_DECODER_CAPS
	}
}
```

### Step 2: Register the Decoder

Built-ins are registered in `src/index.ts` (step 6 of startup), next to the others:

```typescript
import { MyDecoder, MY_DECODER_CAPS } from "./decoders/builtin/my-decoder.js"

decoderRegistry.register(
	"my-decoder",
	(config, logger) => new MyDecoder(config, logger),
	MY_DECODER_CAPS,
)
```

### Step 3: Add Configuration Schema

A decoder's `options` are a free-form record in `DecoderConfigSchema` (`src/config.ts`). Validate
them with a Zod schema in `src/decoders/options/<name>.ts` and export it from
`src/decoders/options/index.ts`, like the built-ins:

```typescript
export const MyDecoderOptionsSchema = z.object({
	mode: z.enum(["auto", "mode1", "mode2"]).default("auto"),
	verbosity: z.number().int().min(0).max(3).optional(),
})
```

### Step 4: Add to Docker Image

Add build stage to `Dockerfile`:

```dockerfile
# Build my-decoder
FROM base-deps AS my-decoder-build
WORKDIR /build
RUN git clone --depth 1 https://github.com/example/my-decoder.git && \
    cd my-decoder && \
    mkdir build && cd build && \
    cmake .. && \
    make -j$(nproc) && \
    make install

# Copy in final stage
COPY --from=my-decoder-build /usr/local/bin/my-decoder /usr/local/bin/
```

### Step 5: Add Tests

Create `tests/unit/decoders/my-decoder.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { MyDecoder } from "../../../src/decoders/builtin/my-decoder.js"
import { createTestLogger } from "../../helpers.js"

describe("MyDecoder", () => {
	const logger = createTestLogger()

	it("should parse signal output", () => {
		const decoder = new MyDecoder(
			{
				id: "test",
				type: "my-decoder",
				enabled: true,
				options: {},
			},
			logger,
		)

		const output = decoder["parseOutput"]("SIGNAL: type=foo value=123")

		expect(output).toEqual({
			timestamp: expect.any(Date),
			decoder: "test",
			type: "signal",
			data: {
				signalType: "foo",
				value: 123,
			},
		})
	})

	it("should return null for empty lines", () => {
		const decoder = new MyDecoder(
			{
				id: "test",
				type: "my-decoder",
				enabled: true,
				options: {},
			},
			logger,
		)

		expect(decoder["parseOutput"]("")).toBeNull()
		expect(decoder["parseOutput"]("   ")).toBeNull()
	})
})
```

## Pattern 2: Network Producer

For decoders that run as services and expose network outputs.

### Step 1: Create the Decoder Class

Create `src/decoders/builtin/my-network-decoder.ts`:

```typescript
import { NetworkProducerDecoder } from "../network-producer-decoder.js"
import type { DecoderConfig, DecoderOutput, DecoderCaps } from "../types.js"
import type { Logger } from "pino"

export const MY_NETWORK_DECODER_CAPS: DecoderCaps = {
	input: "external",
	output: "jsonl",
	wantsExclusiveSource: true,
	integrationPattern: "network_producer",
}

interface MyNetworkDecoderOptions {
	deviceSerial?: string
	gain?: number
}

export class MyNetworkDecoder extends NetworkProducerDecoder {
	protected program = "my-network-decoder"
	protected args: string[] = []

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)

		const options = config.options as MyNetworkDecoderOptions

		this.args = [
			"--output-port",
			String(config.outputPort || 12345),
			"--output-format",
			"json",
		]

		if (options.deviceSerial) {
			this.args.push("--device", options.deviceSerial)
		}

		if (options.gain !== undefined) {
			this.args.push("--gain", String(options.gain))
		}
	}

	protected parseNetworkData(data: Buffer): DecoderOutput[] {
		const outputs: DecoderOutput[] = []
		const lines = data.toString().split("\n")

		for (const line of lines) {
			if (!line.trim()) continue

			try {
				const parsed = JSON.parse(line)
				outputs.push({
					timestamp: new Date(),
					decoder: this.id,
					type: "signal",
					data: parsed,
				})
			} catch {
				this.logger.debug({ line }, "Failed to parse network data")
			}
		}

		return outputs
	}

	getCaps(): DecoderCaps {
		return MY_NETWORK_DECODER_CAPS
	}
}
```

## Pattern 3: External SDR

For decoders that control their own SDR hardware.

### Step 1: Create the Decoder Class

Create `src/decoders/builtin/my-sdr-decoder.ts`:

```typescript
import { ExternalSdrDecoder } from "../external-sdr-decoder.js"
import type { DecoderConfig, DecoderOutput, DecoderCaps } from "../types.js"
import type { Logger } from "pino"

export const MY_SDR_DECODER_CAPS: DecoderCaps = {
	input: "external",
	output: "jsonl",
	wantsExclusiveSource: true,
	integrationPattern: "external_sdr",
}

interface MySdrDecoderOptions {
	outputFormat?: "json" | "text"
}

export class MySdrDecoder extends ExternalSdrDecoder {
	protected program = "my-sdr-decoder"
	protected args: string[] = []

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)

		const options = config.options as MySdrDecoderOptions

		// Device serial from config
		if (config.deviceSerial) {
			this.args.push("-d", config.deviceSerial)
		}

		// Frequencies from config
		if (config.frequencies?.length) {
			for (const freq of config.frequencies) {
				this.args.push("-f", String(freq))
			}
		}

		// Gain
		if (config.gain !== undefined) {
			this.args.push("-g", String(config.gain))
		}

		// Output format
		if (options.outputFormat === "json") {
			this.args.push("-j")
		}
	}

	protected parseOutput(line: string): DecoderOutput | null {
		if (!line.trim()) return null

		try {
			const data = JSON.parse(line)
			return {
				timestamp: new Date(),
				decoder: this.id,
				type: "signal",
				data,
			}
		} catch {
			return null
		}
	}

	getCaps(): DecoderCaps {
		return MY_SDR_DECODER_CAPS
	}
}
```

## Output Types

WaveKit defines standard output types for decoded data:

| Type         | Description            | Used By         |
| ------------ | ---------------------- | --------------- |
| `sync`       | Decoder sync event     | dsd-fme         |
| `call`       | Voice call event       | dsd-fme         |
| `message`    | Text message           | multimon-ng     |
| `signal`     | Generic signal         | rtl_433         |
| `aircraft`   | ADS-B aircraft data    | readsb          |
| `ship`       | AIS vessel data        | AIS-catcher     |
| `acars`      | ACARS message          | acarsdec        |
| `meshtastic` | Meshtastic LoRa packet | lora-meshtastic |
| `vdl2`       | VDL2 message           | dumpvdl2        |
| `aprs`       | APRS packet            | direwolf        |
| `error`      | Decoder error          | all             |
| `stats`      | Statistics             | all             |

### Dynamic Sample Rate Handling

WaveKit automatically restarts decoders when the source sample rate changes (from the web app,
the API or an RTL-TCP relay client). Your decoder does not need special handling—it will be gracefully stopped and restarted with the new rate.

If your decoder has specific sample rate requirements, declare them in `preferredSampleRates`. WaveKit will log warnings when running at non-optimal rates but will not prevent operation.

## Best Practices

### Output Parsing

1. **Handle empty lines** — Return `null` for empty/whitespace lines
2. **Try JSON first** — Many decoders support JSON output
3. **Use regex for text** — Fall back to regex patterns for text output
4. **Log unparsed lines** — Debug log lines that don't match any pattern
5. **Include timestamps** — Always include a timestamp in output

### Error Handling

1. **Don't throw in parseOutput** — Return `null` for unparseable lines
2. **Log parse errors at debug level** — Don't spam logs with warnings
3. **Validate options in constructor** — Fail fast on invalid config

### Testing

1. **Test parsing with real output** — Use actual decoder output samples
2. **Test edge cases** — Empty lines, malformed data, Unicode
3. **Test command line generation** — Verify args are built correctly

### Docker

1. **Pin versions** — Use specific git tags or commits
2. **Minimize dependencies** — Only install what's needed
3. **Test the binary** — Add a verification step in Dockerfile

## Example: Adding a New Aviation Decoder

Here's a complete example adding a hypothetical "hfdl-decoder" for HF Data Link:

### 1. Create the decoder

```typescript
// src/decoders/builtin/hfdl.ts
import { ExternalSdrDecoder } from "../external-sdr-decoder.js"
import type { DecoderConfig, DecoderOutput, DecoderCaps } from "../types.js"
import type { Logger } from "pino"

export const HFDL_DECODER_CAPS: DecoderCaps = {
	input: "external",
	output: "jsonl",
	wantsExclusiveSource: true,
	integrationPattern: "external_sdr",
}

interface HfdlMessage {
	timestamp: string
	frequency: number
	station: string
	aircraft?: string
	message: string
}

export class HfdlDecoder extends ExternalSdrDecoder {
	protected program = "dumphfdl"
	protected args: string[] = []

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)

		if (config.deviceSerial) {
			this.args.push("--device-serial", config.deviceSerial)
		}

		if (config.frequencies?.length) {
			this.args.push(...config.frequencies.map(f => String(f)))
		}

		this.args.push("--output", "decoded:json:file:-")
	}

	protected parseOutput(line: string): DecoderOutput | null {
		if (!line.trim()) return null

		try {
			const data = JSON.parse(line) as HfdlMessage
			return {
				timestamp: new Date(data.timestamp),
				decoder: this.id,
				type: "hfdl",
				data: {
					frequency: data.frequency,
					station: data.station,
					aircraft: data.aircraft,
					message: data.message,
				},
			}
		} catch {
			return null
		}
	}

	getCaps(): DecoderCaps {
		return HFDL_DECODER_CAPS
	}
}
```

### 2. Register it

```typescript
// In src/index.ts
import { HfdlDecoder, HFDL_DECODER_CAPS } from "./decoders/builtin/hfdl.js"

decoderRegistry.register(
	"hfdl",
	(config, logger) => new HfdlDecoder(config, logger),
	HFDL_DECODER_CAPS,
)
```

### 3. Add to Dockerfile

```dockerfile
# Build dumphfdl
FROM base-deps AS hfdl-build
WORKDIR /build
RUN git clone --depth 1 --branch v1.0.0 https://github.com/szpajder/dumphfdl.git && \
    cd dumphfdl && \
    mkdir build && cd build && \
    cmake .. && \
    make -j$(nproc) && \
    make install

# In final stage
COPY --from=hfdl-build /usr/local/bin/dumphfdl /usr/local/bin/
```

### 4. Add configuration

```yaml
# config/default.yaml
decoders:
  - id: "hfdl-decoder"
    type: "hfdl"
    enabled: true
    deviceSerial: "00000005"
    frequencies:
      - 5508000
      - 6559000
      - 8834000
    minVersion: "1.0.0"
```

### 5. Add tests

```typescript
// tests/unit/decoders/hfdl.test.ts
import { describe, it, expect } from "vitest"
import { HfdlDecoder } from "../../../src/decoders/builtin/hfdl.js"

describe("HfdlDecoder", () => {
	it("should parse HFDL JSON output", () => {
		// ... test implementation
	})
})
```

## Troubleshooting

### Decoder not starting

1. Check if binary exists: `docker exec <container> which my-decoder`
2. Check permissions: `docker exec <container> ls -la /usr/local/bin/my-decoder`
3. Check logs: `make app-logs | grep my-decoder`
4. Check why core suspended it: `curl -s localhost:9000/api/decoders | jq '.[] | {id, suspension}'`.
   `frequency-out-of-band` means the capture does not cover its band, `capture-too-narrow` that the
   band is in view but its channel does not fit the capture, `no-channel-selected` that no VFO or
   band-plan channel is chosen yet ([API](API.md) lists every reason).
5. multimon-ng with only paging modes (POCSAG512, POCSAG1200, POCSAG2400, FLEX; the default
   when `modes` is unset) runs only where a paging band of your region is in the capture (the
   band catalogue's VHF paging plan, plus 466.025–466.230 MHz in the EU for French paging),
   so it is `frequency-out-of-band` at 1090 MHz or 433 MHz. With EAS, AFSK1200, FSK9600 or
   DTMF among its modes it has no built-in band and follows the VFO on every band. With at
   least one paging mode, a paging band in view and no
   `channelHz`, `channelsHz`, `offsetHz` or `frequency` it listens on every paging raster
   channel inside the usable window (80 % of the sample rate), nearest the centre first and
   at most 33, each through its own 12 kHz channel filter; a VFO exactly on one of those
   channels starts first, even when 33 others are nearer. With one of those options it keeps
   your channels.
6. The built-in acarsdec (no YAML entry) runs one process per ACARS channel of your region
   inside the usable window, nearest the centre first and at most 5 (EU: 131.525, 131.550,
   131.725, 131.825 and 131.850 MHz; other regions 131.550 and 131.725 MHz). The nearest
   channel, or the VFO when it sits exactly on one of them, starts first; the others start
   only when the CPU budget admits them, so some may show as suspended. It never falls back
   to the capture centre. A YAML acarsdec with `frequencies` keeps one process per listed
   frequency.
7. These extra paging and ACARS channels (all but each decoder's first) always come last in
   the CPU budget. When another decoder needs room, for example AIS with 161.975 and
   162.025 MHz in the capture, that decoder starts and the newest extra channels stop with
   `efficiency-budget`; they retry later. A decoder you configured in YAML is never stopped
   for them.
8. While the scanner watches a source, the core ranks its channels by activity and
   multimon-ng and dsd-fme pick their extra channels by activity instead of nearest the
   centre: besides the first channel (the VFO when it is eligible), they run the channels
   with live or recent energy first (placement origin `activity`), up to 4 extra multimon-ng
   and 2 extra dsd-fme channels per source on x86-64 (1 and 0 on a 4-core arm64 host), fewer
   when the CPU budget is short. A channel that becomes active replaces the least active one
   after that one has run 20 s, at most 6 times a minute per source, and never one that is
   receiving. Each placement's `activity` field (`GET /api/decoders`) says why it runs. Tune
   it with `decoderPolicy.efficiency.activity`: `slots` (`multimon-ng`, `dsd-fme`, 0 to 32),
   `replayAllowanceCores` (default 0.1, 0.05 on arm64), `maxMovesPerMinute` (6) and
   `dwellMs` (20000). Without a ranking (scanner off) the channels are those of items 5 and
   7; while the ranking is unavailable the running extra channels stay and free ones are
   filled nearest the centre first.

### No output being parsed

1. Run decoder manually: `docker exec <container> my-decoder --help`
2. Check output format matches parser
3. Add debug logging to parseOutput
4. rtl_433 runs with `-Y autolevel` by default, so it sets its pulse detection
   level from the noise it measures: its fixed default level misses bursts
   weaker than about -17 dBFS that are plain on a waterfall. To set the level
   yourself, pass one of these in `extraArgs`; WaveKit then adds no level of
   its own: `["-Y", "level=<dB>"]` sets a fixed detection level,
   `["-Y", "minlevel=<dB>"]` sets the lowest level rtl_433 may use, and
   `["-Y", "autolevel"]` keeps the automatic level.

### High CPU usage

1. Check if decoder is in a restart loop
2. Verify input format matches decoder expectations
3. Consider adding rate limiting

### Efficiency recovery

Automatic decoder admission uses a recent 10-second positive-drop window and a separate
60-second clean-evidence window to prevent repeated stop/start cycles. Unchanged cumulative
counters do not extend the drop window. A zero current drop rate can coexist with a recent
`dropping` state; after 10 seconds it becomes `clearing` while the clean window completes.
Missing or stale samples block admission as `unknown`. A waiting candidate is checked again
when clean evidence is sufficient, without the additional backoff used for a failed probation.
After a source reconnect, probation requires fresh coverage; drops recorded in the previous
source epoch do not condemn a resumed decoder. New drops still trigger probation backoff
for suspendable decoders. Decoders protected by `always` mode or an operator start stay
running; after loss, a fresh 60-second clean run with complete evidence lets them graduate
and frees the source's probation slot. CPU over the guard restarts this recovery interval
at the following sample; a full 60 seconds of complete evidence must follow the latest
spike. CPU evidence against an original probation stays failed even after it is evicted
from bounded history; only a fresh clean run can release that protected probation slot.
Drop evidence resets on reconnect, so previous-epoch loss does not condemn a resumed
placement. Continued loss or CPU spikes keep newcomers waiting. Graduation remains
earned when a later CPU spike occurs, including while link recovery delays reconciliation.
Late-drop shedding uses only completed windows ending within the last 30 seconds
(3 × 10 seconds); incomplete later windows cannot keep old loss eligible for shedding.
The budget defaults to half the available CPU capacity, with process and cgroup v1/v2 limits.
The 0.75-core automatic floor is capped at the quota when quota is below 0.75;
see [configuration](CORE-REFERENCE.md#decoder-efficiency-cpu-budget).

A clean completed 30-second probation resets normal consecutive-failure retry backoff
in both admission and the decoder manager. After late-drop shedding, retry history
resets only after a clean run of at least 30 minutes since readmission. A shed or
probation failure before then doubles the delay from 5 to 10 to 20 minutes, capped
at 30 minutes. After that sustained clean run, the next failure starts at 5 minutes.

The dsd-fme scanner link event distinguishes `verified` content from sync-only
fields. DMR color code from voice/IDLE sync is an unverified hint, not an
identity. Only checked data bursts or checked target/source voice link control
can participate in the scanner's two-match identity confirmation. CRC/FEC
failures and `-RAS` output never count. MBCC has no own CRC
(ed1d1d6 `dmr_dburst.c:115–119,627`), so it cannot verify a CC.
MS voice LC does not borrow CC from a pending checked header: the opening CC
precedes slot-type decoding (`dmr_ms.c:676–686`). Checked TG/SRC remain usable
with CC unknown while that header awaits its closing-sync check.
NXDN accepts only current CRC-checked ` RAN 03  FACCH2`/UDCH output
(`nxdn_deperm.c:1390–1437`); failure omits RAN, and SACCH/CAC print cached RAN.
Other protocols also require a known checked print format;
unknown formats default to unverified. See [Digital voice identity checks](SCANNER.md#digital-voice-identity-checks).

### readsb aircraft evidence

The default `outputFormat: "sbs"` selects `--net-sbs-port`; the adapter maps each
`MSG` line to an aircraft record with a fresh `lastSeen` and `messageCount: 1`.
That count describes one line, not readsb's cumulative aircraft state.
The adapter also carries `sbsSourceTimestamp` and `sbsContentId` (SHA-256 of the
complete source line). Generated date/time fields 7–8 supply source time; logged
fields 9–10 are used only when both generated fields are absent. Strict calendar
and clock validation rejects malformed values without falling back. SBS has no
timezone, so its wall clock is normalized to UTC for deterministic intervals.
Records without valid source time never confirm.

Scanner confirmation relies on readsb's own decoding and two independent messages
of the same ICAO at least 2 s and at most 5 min apart in readsb's own time, with
different content identities. Receipt delays and identical line replays cannot
satisfy this guard. JSON output sets `readsbFormat: "json"` and maps `messages` to
the cumulative count; it requires a count greater than one and count advancement,
2 s to 5 min apart in source time (`jsonSourceTimestamp`, numeric `now` epoch
seconds minus nonnegative `seen` age). Snapshots lacking valid source epoch/age
still map for display but cannot confirm. Beast keeps local CRC/address validation and
distinct-frame confirmation without a minimum interval.

SBS/JSON validation is delegated to readsb; their records do not expose whether a
CRC was corrected or the address was independently confirmed. We could not verify
offline the CRC-correction/address-confirmation policy for the pinned build
`b499ecbd18dc4a2ec6098c31de31508017fa6190` in `Dockerfile`. The adapter mapping
and two-message guard do not establish those upstream guarantees.
See [scanner ambient identification](SCANNER.md#identification-from-running-decoders) for tuning
trust: readsb's protocol declaration supplies 1090 MHz when raw placements have
no explicit target, but only observed tuning that covers it establishes trust.

IQ replay uses a separate offline clock for single-channel VDL2: the capture tool
resamples to 105 kHz and converts to unsigned 8-bit IQ before dumpvdl2 reads
`--iq-file - --sample-format U8 --oversample 1`. The 25 kHz channel fits a 48 kHz
capture. For 125 kHz LoRa, capture uses 192 kHz with a wider passband and replay
resamples to 250 kHz U8, matching the Python wrapper’s two samples per chip.
Automatic scanner trials also need probe-pool decoder admission and confirmation;
see [scanner replay](SCANNER.md#iq-capture-on-detection).
