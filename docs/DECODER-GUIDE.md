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

A decoder with `useChannelizer` and a channel request (`getChannelRequest`, which
`AudioDemodDecoder` and `IqDecimateDecoder` provide) reads a `wavekit-chan` channel on stdin
instead of the raw source stream. By default the channel socket itself is the decoder's stdin,
handed over at the spawn, so the channel's bytes never pass through Node and `bytesIn` is updated
from the channelizer's 5-second `stats` lines. With `WAVEKIT_CHANNEL_INPUT=relay` Node relays it
instead: the channel socket is piped into the decoder's stdin. Either way the decoder sees the same
byte stream, so an adapter needs no change. When the channel closes (a capture-centre move, for
example) a direct decoder sees EOF; whether it exits then or keeps running, the core restarts it
once, with no crash counted, or holds it until its source returns when the source has gone.
[PERFORMANCE.md, "Direct channel input"](PERFORMANCE.md#direct-channel-input-2026-11-17) has the
details.

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

The `acars` and `vdl2` payloads (address types, direction, XID parameters, libacars results) are
described in [Aircraft data link](AIRCRAFT-DATALINK.md).

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

### Frame counters

A `BaseDecoder` adapter whose tool already counts what it hears can report it through
`this.counters` (`src/decoders/decoder-counters.ts`): `cumulative(sample)` for counts since
the child started (a lower reading is taken as a restart), `delta(sample)` for counts per
report, or `count(name, by)` for occurrences in lines the adapter already parses (sent every
10 s). Names must be in `DECODER_COUNTER_NAMES` (`@wavekit/api-types`); a report with any
other name, or a value that is not a finite number, counts nothing. Values clamp to
non-negative safe integers. The manager keeps totals since the core started (a placement
worker's fold into its decoder's) and the last minute's growth, and the summary route turns
them into `counters` and the `reception` hint. Never add per-sample work for a counter: count
only what the tool already prints or the adapter already parses.

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
   band-plan channel is chosen yet, `source-paused` that the receiver feed is paused (resume it
   with `POST /api/sources/<id>/resume`) ([API](API.md) lists every reason).
5. multimon-ng with only paging modes (POCSAG512, POCSAG1200, POCSAG2400, FLEX; the default
   when `modes` is unset) runs only where a paging band of your region is in the capture (the
   band catalogue's VHF paging plan, plus 466.025–466.230 MHz in the EU for French paging and
   929.0–932.0 MHz in the US and Canada for 900 MHz paging), so it is `frequency-out-of-band`
   at 1090 MHz or 433 MHz. With EAS, AFSK1200, FSK9600 or DTMF among its modes its band is
   the union of the ranges where each mode's service exists in your region: paging ranges for
   POCSAG and FLEX; for AFSK1200 the national 2 m APRS channel (144.800 MHz in the EU,
   144.390 MHz in the US and Canada, 145.175 MHz in Australia, 144.575 MHz in New Zealand,
   144.660 MHz in Japan, 144.640 MHz in China), the amateur 2 m and 70 cm bands, the ISS
   packet channel (145.825 MHz ± 12.5 kHz) and the 70 cm satellite packet channel
   (437.775–437.825 MHz) in every region; analog FM voice ranges for DTMF (PMR446, land
   mobile, marine, amateur 2 m / 70 cm, CB); the amateur 2 m and 70 cm bands for FSK9600
   (EU 144–146 and 430–440 MHz, US and Canada 144–148 and 420–450 MHz, and the ITU-wide
   144–146 and 430–440 MHz in Australia, New Zealand, Japan and China, whose band plans list
   no amateur bands yet); and the NOAA Weather Radio / Weatheradio Canada band for EAS
   (162.400–162.550 MHz in the US and Canada; SAME is not broadcast elsewhere, so EAS adds
   nothing there). When a mode's service has no band data in your region at all, the band
   stays unknown and the decoder follows the VFO, so missing data never stops a working
   decode. Elsewhere it is suspended with `frequency-out-of-band`
   ("waiting: the tuned frequency is outside its band"): at 1090 MHz in every region, and
   in the EU also in the 863–870 MHz ISM band. In the US and Canada 851–869 MHz is land
   mobile, so with DTMF among its modes it runs at 868.95 MHz there. Any of `channelHz`, `channelsHz`, `offsetHz`,
   `frequency` or `frequencies` pins it to your channels: whatever its modes (paging-only
   included) it is then never suspended for being off its mode band. Top-level `frequencies`
   and a band override (`band` in YAML or the API) still win too. Unknown mode names are
   dropped, as the decoder drops them. With at least one paging mode, a paging band in view and no
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
   frequency. Each process demodulates the 25 kHz AM channel (flat to ±6 kHz, stopped by
   ±12 kHz). The acarsdec option `channelFilter: true` (experimental, pending measurement;
   default off) adds a 9.2 kHz channel filter before the demodulator: flat over one ACARS
   block (±3.6 kHz) plus 1 kHz for the aircraft transmitter (5 ppm) and Doppler at 137 MHz,
   3 dB down at 5 kHz, 6 dB at 5.1 kHz and 55 dB at 5.6 kHz, so it rejects an 8.33 kHz voice
   neighbour (about 62 dB down). It barely attenuates a carrier 5 kHz off the channel (3 dB),
   and it leaves the receiver about 2 ppm of frequency error, so a dongle without a TCXO or a
   ppm correction clips a sideband. It runs on the raw IQ path and on channelizer IQ; on the
   raw path it is left out (one log line) when `offsetHz` is set, and on any path below an
   11.2 kHz or above a 255.5 kHz demodulation rate (past that its filter outgrows the bounded
   csdr buffer).
   The built-in dumpvdl2 decodes every VDL Mode 2 channel of your region in one process. In
   the EU these are 136.725, 136.775, 136.825, 136.875, 136.925 and 136.975 MHz, the VHF
   digital link frequencies of Commission Implementing Regulation (EU) No 1079/2012.
   In other regions, and for a YAML dumpvdl2 without `frequencies`, it decodes 136.650,
   136.700 and 136.975 MHz (136.975 MHz is the worldwide common signalling channel), as
   before; a YAML dumpvdl2 in the EU should list the EU channels in `frequencies`. The EU channels span 250 kHz and need a 300 kHz channel around 136.850 MHz,
   which fits a capture of 1.024 Msps or more centred near that frequency. Limitation:
   dumpvdl2 is given the whole list. On the raw IQ path a channel outside the sampled window
   is passed anyway and cannot be decoded there; on the channelizer a list whose span does
   not fit the channel rate is rejected (`channel-request-invalid`). WaveKit does not trim the
   list to the channels inside the window, so list only channels your capture covers.
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
   receiving. A dsd-fme channel must also have been heard for at least 10 s before it may
   replace a running one: two energy observations at least 10 s apart (one transmission of
   10 s or more, or two transmissions 10 s apart) within the last 120 s, so a single short
   burst never moves a slot; free slots still fill at once. dsd-fme also considers
   scanner-observed energy centres when no explicit decoder channels are configured,
   including channels absent from the protocol band plan, but its extra channels sit only
   inside a digital-voice range of your region's built-in band plan (VHF and UHF land mobile,
   in the US and Canada also 700, 800 and 900 MHz land mobile: 769–775, 799–805, 806–824,
   851–869, 896–901 and 935–940 MHz; PMR446 and dPMR446, amateur 2 m and 70 cm) and never in
   an ISM/SRD or LoRa range of your region's plan (in the EU 433.05–434.79 and 863–870 MHz;
   in the US and Canada 868.95 MHz lies in 851–869 MHz land mobile and may hold a slot). Its
   first channel (the VFO) is not limited this way.
   No protocol hint is required: energy selects a trial channel, and the existing checked
   decoder output rules still decide whether it is verified digital voice. Band, capture
   reach and CPU admission still apply. Observed candidate identities initially use round(Hz / 6250) × 6250 (ties upward).
   A track keeps that identity until its actual centre is more than 3625 Hz away
   (half the raster plus 500 Hz hysteresis), limiting identity error to 3625 Hz.
   Coverage deduplication uses the actual energy centre against half the decoder
   bandwidth; rounding an uncovered centre into that range does not discard it. The manager accepts at most 512 finite positive integer
   centres per source epoch; a malformed result is treated as empty. Nearby FFT centre changes reuse the existing
   channel, and burst gaps keep its placement eligible for the usual dwell and move rules.
   Each placement's `activity` field (`GET /api/decoders`) says why it runs. Tune
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

multimon-ng prints FLEX alphanumeric pages as
`FLEX|2026-01-02 03:04:05|1600/2/K/A|05.012|001234567|ALN|text` and numeric,
tone and unknown pages as `FLEX: 2026-01-02 03:04:05 1600/2/A 05.012 [001234567] NUM 12345`.
With timestamps off they are `FLEX|1600/2/K/A|05.012|001234567|ALN|text` and
`FLEX|1600/2/A|05.012|[001234567]|NUM 12345`; group pages list the member
capcodes after the first (`groupCapcodes`). The adapter's `frequency` field
holds the cycle.frame value, `fragment` the K/C/F flag.

To check a whole chain without on-air traffic,
`tests/integration/synthetic-frames.test.ts` builds bit-level synthetic
transmissions (APRS, FLEX, D-STAR, YSF, P25 phase 1, NXDN48/96, dPMR; generators
in `scripts/fixtures/`) as cu8 IQ at 1.024 and 2.4 Msps, runs them through
wavekit-chan and each adapter's production command line, and checks the decoded
fields, scanner evidence and Activity row. Cases whose binaries are missing skip;
`WAVEKIT_SYNTH_IMAGE=<core image> pnpm exec vitest run tests/integration/synthetic-frames.test.ts`
runs every command inside the core image instead (raw csdr path and direwolf
included).

### Wireless M-Bus meters (868.95 MHz)

Mode C/T uplinks need at least 1.2 Msps: 100,000 bits/s × 12 samples/bit.
The pinned rtl_433 (`19f788d0d67720ac23556b5bcdbad63a005637f2`) enables
protocol 104 (Wireless M-Bus, Mode C&T, 100kbps), 105 (Mode S, 32.768kbps)
and 238 (Mode T downlink, 32.768kbps) by default. No extra `-R` flags are
needed with the default protocol list. An explicit `protocols` list must include
104 for C/T uplinks. S and T downlink use 868.3 MHz and need 1 Msps.
Protocols 106 (Mode R, 4.8kbps) and 107 (Mode F, 2.4kbps) are disabled,
experimental stubs; they are not needed for 868.95 MHz meters. Source:
[pinned m_bus.c](https://github.com/merbanan/rtl_433/blob/19f788d0d67720ac23556b5bcdbad63a005637f2/src/devices/m_bus.c#L1118-L1187).

A catalogue rtl433 placement reads the complete capture unchanged from 250 ksps
through 2.4 Msps, at the tuner centre. This raw branch avoids channelizer work.
At 2.4 Msps it supplies 24 samples per 100 kbps bit, twice the C/T minimum.
For channel placements with a target of at least 1 MHz, when the regional band
includes 868.95 MHz, the planner can widen the existing ISM channel to cover both
its original span and the meter span (868.95 MHz ±600 kHz). The union must fit
inside the usable window and the 2.4 Msps maximum, including rounding the rate
up in 1 kHz steps. The resulting channel uses at least 1.2 Msps and preserves coverage
for other sensors. Otherwise the original ISM placement remains unchanged;
explicit targets below 1 MHz disable this widening. Widening also requires the
remaining CPU budget to cover the channel cost: 0.21 × (rate / 1 MHz) cores
above 1 MHz, plus the existing shared channelizer and replay allowances. The EU rtl433 band is
863–870 MHz; other regions retain their own band policy. A detected packet count alone does
not prove wM-Bus: it can include unrelated protocols, noise or damaged frames.

The JSON model is `Wireless-MBus`; the pinned output uses `C` for the control
field (not `C_field`), plus `mode`, `M`, `id`, `version`, `type`, `type_string`,
`data` and `mic: "CRC"`. Encrypted payloads can still identify a meter, but
rtl_433 does not decrypt them. Activity labels these receptions `wmbus`.

Wireless M-Bus meter IDs and readings are personal data, stored like other sensor IDs.
Validation so far uses synthetic fixtures; live meter decodes have not been observed.

### Meshtastic (lora-meshtastic)

The wrapper (`docker/scripts/lora_meshtastic_decode.py`) takes each frame from gr-lora_sdr's
`crc_verif` output stream. It keeps only frames whose LoRa payload CRC is valid. It then
reads the 16-byte on-air header: to, from, packet id, flags (hop limit, want-ack, via MQTT,
hop start), channel hash, next hop and relay node. Last, it decrypts the rest with the
channel key (AES-128-CTR) and parses the Meshtastic `Data` message. A frame that fails any
step is dropped. Drops are counted by reason (`crc_bad`, `short_frame`, `data_parse`,
`bad_portnum`, ...) and written to the decoder log at most once a minute as a `frame_drops`
line, with a `frame_drop_summary` line at exit. Single frames are never logged.
Every 10 s and at exit the wrapper also writes one machine-readable line on stderr,
`WAVEKIT_STATS {"v":1,...}`, with its counts since start: `inputSamples`, `preambles`
(frame_sync locks), `headersOk` (valid headers), `framesOk` (packets written), `crcBad` and
`parseDrops` (other drops, not the dual-path duplicates). The adapter validates it with Zod and
reports the counts as frame counters (`counters` on `GET /api/decoders/summary`); a malformed
line counts nothing and is not logged.
`rx_rssi` and `rx_snr` are 0, because gr-lora_sdr does not measure them.

The decoder demodulates the capture centre (`reach: centre`), and its channel may sit off
that centre. The planner places a LoRa slot only where it still decodes: the slot plus a
crystal margin must stay below 190 kHz at 500 kS/s, where sox's `rate -m -b 74` filter is
at −4.2 dB (it is −3 dB at 185 kHz). The margin is 23 ppm of the slot frequency: 20 kHz at
869.525 MHz, 10 kHz at 433.875 MHz. For LongFast at 869.525 MHz that leaves
190 − 125 − 20 = 45 kHz, so the passband is 250 + 2 × 45 = 340 kHz. The limit is never more
than bw/5 (50 kHz for the 250 kHz presets). A 62.5 kHz preset has no room left after the
margin, so its slot must sit on the centre. A frame 200 kHz off centre does not decode. The
DC spike at the centre does not stop decoding: a synthetic frame decoded at +10 and −5 dB
SNR with or without one. The fixtures and tests are described in `fixtures/lora/README.md`.

A frame arrives off its nominal frequency for two reasons:

- The transmitter's crystal is off by some parts per million (10 ppm is 8.7 kHz at
  869 MHz). The same error makes its symbol clock run fast or slow.
- The channel sits off the capture centre. This is a pure frequency shift with no clock
  error.

gr-lora_sdr measures any offset up to ±bw/4, but it always corrects the clock error that a
crystal offset would bring. On a pure shift that correction is wrong. At 5 kHz it moves the
symbol timing by half a chip within a short frame. Meshtastic's coding rate 4/5 corrects no
symbol error, so the frame is lost.

The shift is known, though: it is the slot frequency minus the capture centre. The decoder
passes it to the wrapper as `--shift-hz` (positive when the slot is above the centre, for
example `--shift-hz 25000` for a slot at 869.525 MHz on a capture centred at 869.5 MHz).
The wrapper rotates the stream by that amount in gnuradio's C++ rotator before
gr-lora_sdr, so gr-lora_sdr sees only the crystal error, and its clock correction is then
right. This single path is the default. It expects the 16 preamble upchirps Meshtastic
sends. When the capture centre moves, the decoder restarts with the new shift. With
`followCenter` the slot is the centre itself, so the shift is 0.

If the decoder does not know the capture centre, it passes `--shift-hz 0` and turns on
the carrier-offset search (`--cfo-search-hz`, bw/5). The search is off whenever the shift
is known. It adds a second, recentred path. That path measures each preamble's offset from
its upchirps and downchirps, to within one bin (122 Hz for LongFast), shifts the stream by
that offset and decodes the result. It runs 32 symbols behind the direct path (262 ms for
LongFast), so the shift starts before the preamble. The recentred path removes the offset
but not the clock error that comes with a crystal offset. That error moves the symbol
timing by 2048 × offset / 869.525 MHz chips per symbol, which passes half a chip within the
40 symbols after sync once the crystal part of the offset is above 5.3 kHz. So with the
search, a frame with both an unknown shift and a crystal error above about 5 kHz can still
be lost. That is the failure the known shift removes.

With the search on, a frame that both paths decode is emitted once. Each copy is placed by
the input sample where gr-lora_sdr locked on it (the recentred path's less its 32-symbol
delay), and two identical copies from different paths pair when those positions agree
within 4 symbols (33 ms for LongFast). Thread timing does not matter, and identical frames
that one path decodes are separate receptions, all emitted. The drop lines carry a `path`
field (`direct` or `recentred`), and a `duplicate` drop is the second copy of a frame. A
`position_evicted` or `position_unaligned` count is a frame emitted without a position, so
it is never paired: a lost pairing gives a duplicate packet, never a missing one. At exit,
a `cfo_search_summary` line gives the number of preambles found and the last offset
measured.

Two frames that overlap in time on the same channel (a collision) are not both decoded.
gr-lora_sdr follows one frame at a time: a preamble that starts while a frame is being
received is not detected, and if the later frame is strong enough it corrupts the one in
progress, which then fails its CRC (`crc_bad`). Frames that follow each other without
overlapping, such as a relay of a packet, decode separately.

The wrapper's stdout carries only the JSON packet lines. gnuradio logs at warn level and
above, and anything native code prints to stdout goes to stderr instead.

The core image has no pnpm or development dependencies, so the acceptance check for offset
handling is the bench, run inside the core image from the repository root and never
against a live receiver:

```bash
python3 scripts/fixtures/bench_lora_cfo.py --cpu-seconds 60
python3 scripts/fixtures/bench_lora_cfo.py --variant known --variant search --repeat 1
```

It gives each committed capture 16 preamble upchirps, then a crystal error (0, ±5, ±10
and ±20 kHz, with its clock error) and a shift off the capture centre (0, ±25 and
±45 kHz). It pipes each case through sox and the wrapper with the decoder's own arguments:
`known` passes the shift as `--shift-hz` (the default decoder), `search` uses the search
instead (an unknown centre) and `none` uses neither. It prints the decodes of each path,
the measured offset and the CPU of each stage per second of signal. It exits with status 1
when a `known` case with a shift within `--target-hz` (default 45 kHz) and a crystal error
within `--crystal-target-hz` (default 20 kHz) decodes other than one packet per copy.
`--cpu-seconds 60` also measures the steady CPU of the default chain on noise alone: a
70-second run less a 10-second run, so the gnuradio start-up cost cancels out.

Decode and CPU figures for the known-shift path have not been measured yet. Run the bench
in the core image before relying on them.

gr-lora_sdr needs a sample rate that is a whole multiple of the LoRa bandwidth
(`samp_rate = bw × os_factor`). The decoder runs it at `bw × 2` by default, 500 kS/s for
the 250 kHz presets; the `oversampling` option changes the factor. A capture at exactly
that rate goes straight to the wrapper. Any other rate passes once through sox
(`rate -m -b 74`): a 1.024 Msps capture becomes 500 kS/s, because 1.024 Msps is 4.096 ×
250 kHz. Earlier versions resampled to `bw × 8` (2.0 Msps) at `rate -h`: four times the samples
for gr-lora_sdr. In the core image on one CPU, both committed captures decoded 10/10 at
`bw × 2`, `× 4` and `× 8`, and `bw × 2` cost the least CPU. The wrapper exits with an `invalid_sample_rate` line if
`--samp-rate` is not a whole multiple of `--bw`. To compare oversampling factors and sox
settings on the committed captures, run `python3 scripts/fixtures/bench_lora_chain.py` in
the core image; it prints decodes and the CPU of each stage per second of signal.

### APRS (direwolf) KISS and AGW ports

direwolf has no command-line option for its KISS TCP or AGW port. WaveKit therefore
writes a config file for each instance before it starts direwolf, and passes it with
`-c`. The file is created in an owner-only directory under the OS temp dir and removed
when the decoder stops. It holds the image's `/etc/direwolf.conf` (`MYCALL`, `ADEVICE`,
`CHANNEL`) without any `KISSPORT`/`AGWPORT` lines, then `KISSPORT 0`, `KISSPORT <kissPort>`
and `AGWPORT <agwPort>` from the decoder options (defaults 8001 and 8000). direwolf 1.8.x
still opens its default KISS port 8001 beside a configured one; `KISSPORT 0` turns that
off, so only the configured ports open. WaveKit connects to the same `kissPort`. Two direwolf instances need different `kissPort` and `agwPort`
values, or the second cannot bind its ports.

### High CPU usage

1. Check if decoder is in a restart loop
2. Verify input format matches decoder expectations
3. Consider adding rate limiting

### Decoders start when you tune

In `auto` mode (the default) you never need Settings to start a decoder: tune into its band
and it starts. When you tune, the core decides for each decoder in this order:

1. **Mode.** A decoder set to `off` in Settings (or `enabled: false` in YAML) never starts,
   whatever you tune. `always` runs everywhere; `auto` runs where its band is. Pressing
   **Stop** on an `auto` decoder keeps it stopped until you start it, change its mode or
   tune into its band again: once your VFO has settled (stayed put for 1 second) inside its
   band after being outside it, the core starts it again as one it started on its own, so
   the CPU budget can still pause it. Your tunes are the tuner frequency you set in the web
   app or the API, a live audio setting, and a retune from SDR++ through the relay. Moving
   within its band, a scanner sweep's hops, the sweep's restore of your frequency afterwards
   (even when it lands only after a reconnect), a live audio change the demodulator rejected
   and put back on its own, a reconnect (including one that returns the tuner to its
   configured frequency) and WaveKit starting up are not tunes: they leave a stopped decoder
   stopped. A tune you make right as a sweep ends is yours, not the sweep's restore. A
   stopped `always` decoder stays stopped until you start it.
2. **Source ready.** A sample-rate change reconnects the source; until the new rate is known
   decoders wait as `source-rate-unknown`.
3. **Band.** The decoder's band (ADS-B 1090 MHz, APRS 144.800 MHz, ISM 433/868 MHz, ACARS and
   VDL2 near 131 and 136 MHz, LoRa near 869.5 MHz, the paging and digital-voice bands of your
   region, or your band override) must be in the capture, else `frequency-out-of-band`.
4. **Rate.** The capture must suit the decoder (ADS-B needs 2.4 Msps; unless ADS-B is `off`,
   WaveKit raises the rate when you tune within 200 kHz of 1090 MHz in WaveKit; a retune made
   in SDR++ through the relay only gets advice), else a rate reason such as `insufficient-sample-rate`.
5. **Placement.** Channel decoders need a channel that fits the capture (`capture-too-narrow`,
   `no-channel-selected`) and the channelizer (`channelizer-unavailable`). A request caught by
   a capture-centre move fails with that reason once, and the next request uses the same process.
6. **CPU budget.** Decoders the core started on its own share a CPU budget
   (`efficiency-budget`). The decoder whose band holds the frequency you tuned (the VFO on its
   source, within 200 kHz of its targets or the span between them, or inside its band) goes
   first. The VFO tunes only the source it is on: a second dongle is not "tuned" by its own
   capture centre while the VFO is elsewhere, and only with no VFO at all does the default
   source's capture centre stand in for it. A source a scanner sweep holds is never tuned;
   once the sweep releases it, priority follows wherever its VFO now is, whether a hop, the
   sweep's restore or you put it there.
   For the tuned decoder:
   - it is admitted before the others, and when the budget is full the other automatic
     decoders stop to make room (newest first);
   - after a reconnect it starts as soon as the source delivers a clean run (about 6 seconds
     after the rate change), instead of waiting the 60-second clear window others wait; while
     it waits it is checked again on every 2-second efficiency sample;
   - when CPU load, or host overload dropping data on another decoder's input or on the source
     with no one decoder to blame, forces the core to stop something while the tuned decoder is
     new, it stops the other automatic decoders first: for CPU load at most one every 60
     seconds across all sources (CPU is shared), for host overload at most one per source every
     60 seconds. For host overload charged to particular decoders' inputs it stops the newest
     of those first, before any decoder whose input stayed clean; otherwise the newest goes.
     The tuned one stops only when nothing else is left, and says so. Drops on its
     own input are its own: it stops, not a bystander.

   Tuning into a band also clears any earlier budget or loss wait of its decoder, once the
   tuned frequency has stayed in that band for 1 second (passing through a band on the way
   elsewhere clears nothing). Only your own tune does this: after a scanner sweep has held
   the source, neither its hops, its restore of your frequency nor the time you had already
   spent in the band clear a wait; your next settled tune on that source does, even one
   within the same band or one made the moment the sweep ends. YAML decoders, `always`
   decoders and decoders you started yourself are never stopped for it.

7. **Start.** The process then starts; ADS-B shows aircraft once readsb has heard them.

Each decoder's verdict in `GET /api/decoders/summary` sums this up in one sentence with a
suggested action, for example "ADS-B paused: CPU budget full" with `raise-budget`. That
verdict appears only when the budget is what holds the decoder back; one waiting to be
checked again reads "waiting for the source to settle", with no action.

### Which CPU counts against a decoder

The CPU budget's guard (90 %) is judged on the core's **own** CPU: the CPU time of its
container (core, workers, channelizer and every decoder process), read every 2 seconds from
the container's cgroup and compared with the CPU capacity the automatic budget is sized from
(`min(available CPUs, quota / period)`). Own CPU over 90 % of that capacity counts only once
it has held for 10 seconds: five consecutive samples, each no more than 4 seconds after the
previous one. Only then is it evidence against the newest automatic decoder on probation (or
against the untuned decoder stopped to make room for a tuned one), and only then does it hold
back new automatic decoders. Four samples (a decoder's start-up burst, or the core sitting at
its CPU quota for 8 seconds) are not, and a sample under the guard, an unknown reading or a
longer gap starts the count again.

A decoder stopped for `cpu` is held: none of its placements on that source (any channel) is
started again until the core's own CPU has stayed below 80 % of its capacity (the guard
minus 10 points) for a full 60 seconds after the stop (30 consecutive samples, restarted by
any sample at or above 80 %, an unknown reading or a gap), or until you start the decoder
yourself (an operator start). The hold belongs to the decoder on its source, not to one
channel: a channel worker the activity plan moves to another channel, a replan that removes
and re-adds it, or a tuned decoder's settle after a retune keeps it held. Its usual retry
delay applies as well, and host CPU does not shorten either wait. So a core running between
80 % and 90 % of its capacity neither stops more decoders for CPU nor brings back the ones it
stopped, and a stop is never undone within one sample. A tuned-band decoder that is waiting
this way can still take the place of untuned decoders that cover its cost. An operator start
ends the hold of any decoder, tuned or not; for the tuned decoder it also clears its retry
delay. A channel worker removed by a replan is not logged as a resume ("Decoder suspension
changed" with no reason code): the decoder stays held.

A hold that lasts 10 minutes (10 release windows of 60 seconds, counted from the stop) logs one
warning, "Decoder still held for cpu", naming the decoder and the reason it cannot end on its
own: `own-cpu-unavailable` (the core's own CPU cannot be read, so no release run can start)
or `above-release-level` (own CPU, given rounded as `ownPercent`, is at or above the 80 %
release level). The warning is logged once per hold; a later stop for `cpu` may warn again.
Start the decoder yourself to end the hold.

Host CPU (every process on the machine, another project's build included) never stops,
refuses or late-stops a decoder for host CPU alone. It only explains drops: while the host is
over the guard and the core's own CPU is not, drops on a graduated decoder's input are the
host's, and they stop no automatic decoder outside the tuned band until the host calms
(consumer loss charged to that decoder's own input still does). That loss is not silent:
while it lasts, the decoder's entry in `GET /api/decoders/efficiency` carries
`hostExcusedLoss` (cause `host-busy`, [API.md](API.md#get-apidecodersefficiency)), and the core
logs "Late loss excused: host busy" once when it begins and "Late loss no longer excused" once
when it ends. It begins only when the excused loss would have stopped the decoder without the
excuse (two of the latest three 10-second windows), so a stray drop now and then shows nothing.
It ends when the host calms, when the decoder stops or is late-judged again, or 30 seconds (a
full set of three windows) after its newest excused window; while a new decoder on the same
input is still on probation, no excuse is shown. The log line "Decoder
efficiency drops or CPU limit exceeded" reads `efficiencyDetail: "host-cpu"` in that case and
`"cpu"` only for the core's own CPU.

For a decoder of the tuned band, host CPU excuses a run of drops on its own input for at most
30 seconds from the run's first drop; past that, the loss is its own and the decoder can
still be late-stopped. A run ends after 10 seconds without such a drop, and a new run starts
its own 30 seconds. A tuned decoder on probation whose excused run is still open can
graduate meanwhile; if the run outlasts the 30 seconds, it is then stopped as `late-drops`,
not `drops`. After the 30-second excuse, the stop can take up to two more 10-second late windows
(the loss must fill two of the latest three), so it comes about 30 to 35 seconds after the run's
first drop for a decoder that had already graduated, and about 50 to 55 seconds when the run
began while it was still on probation.

The own reading needs the core in a container with a private cgroup namespace
(`/proc/self/cgroup` is `0::/`, the Docker default with cgroup v2). Elsewhere (`pnpm run dev`
on macOS, a bare Linux shell, cgroup v1) the core logs `own CPU unavailable: CPU shedding off`
once and stops nothing for CPU; drops and the budget's cost estimate still govern. Every
probation verdict is logged as "Efficiency probation verdict" with `ownCores` and
`capacityCores` (null when unknown) and, for a decoder stopped to make room for a tuned one,
the probationer whose evidence it was; every admission logs "Efficiency admission" with its
time.

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
and frees the source's probation slot. Own CPU over the guard (held 10 seconds, as above)
restarts this recovery interval at the following sample; a full 60 seconds of complete evidence must follow the latest
spike. CPU evidence against an original probation stays failed even after it is evicted
from bounded history; only a fresh clean run can release that protected probation slot.
Drop evidence resets on reconnect, so previous-epoch loss does not condemn a resumed
placement. Continued loss or CPU spikes keep newcomers waiting. Graduation remains
earned when a later CPU spike occurs, including while link recovery delays reconciliation.
Drops are charged to the fanout branch that dropped them, during probation as after it: a
new decoder is judged only by drops on its own input (its raw branch or the channelizer's),
never by drops on live audio or on another decoder's branch.
Late-drop shedding uses only completed windows ending within the last 30 seconds
(3 × 10 seconds); incomplete later windows cannot keep old loss eligible for shedding.
Late drops are charged to the fanout branch that dropped them: a raw decoder (such as
ADS-B) is stopped only for drops on its own branch, channelizer drops stop only decoders on
channelizer channels, and drops on live audio stop no decoder. Burst absorber overflow is
charged to the branches that held the absorber when it overflowed (a congested branch holds
input for every branch): a congested live audio branch stops no decoder, even when it
closes before the next sample (its share is kept for two samples). Overflow with no
holding branch known is charged to the source as a whole, even when live audio dropped too. Among the decoders charged, the newest automatic one is stopped,
decoders of the tuned band last; `always` and operator-started decoders are never stopped.
A decoder of the tuned band (such as ADS-B) on probation is judged only by drops on its own
branch: overflow charged to the source as a whole, the core's own CPU over the guard (its
share of the container's CPU capacity), or host loss on another decoder's branch stops the
newest other automatic decoder instead, at most one per
60-second clear window on each source (one host-wide for CPU). Under sustained CPU load the
tuned decoder is never stopped: it restarts its probation instead, and loss already spent on such a stop does not stop a second decoder through late drops
on that source until the window has closed. After a stop for CPU, host-attributed drops on
any source are that same load and stop nobody else until that stop's own 60-second window
has closed; stops for other loss inside it do not extend it. Other
fresh drops on another decoder's own branch within that window are new loss and still
stop it. A decoder's own branch drops count as
its own even when overflow with no holder known falls in the same sample.

**Host starvation never stops the tuned decoder.** The tuned decoder is the one whose band
holds the tuned frequency, or the only decoder running (all of its placements, and also when
it is started or retried while nothing else runs). A drop on its branch is host loss,
not its own, when within 10 seconds either side of it (one late-drop window, 5 samples of
2 seconds) another fanout branch also dropped (live audio included, even in a different
sample) or the sample was attributed to the host (event-loop delay of 50 ms or more, or
host CPU at the guard). A running decoder's late drops are judged only once those
10 seconds have been sampled. On probation, a single drop also waits those 10 seconds
(its probation does not end before then), since a host episode can reach another branch
in the next sample; its own branch dropping alone in two samples in a row, while the
others flow and the host is healthy, stops it at once. Host CPU alone (no other branch
dropping and no event-loop delay, even when CPU stays at the guard on every sample) excuses
its own branch's drops for at most 30 seconds (3 windows of 10 seconds), on probation and
while it runs after probation alike: if its branch keeps dropping alone that long, the loss
is its own and stops it (on probation at once, after probation through its late-drop
windows). The other two excuses, another branch dropping within 10 seconds and event-loop
delay of 50 ms or more, have no time bound: while they last the tuned decoder is never
stopped, however long, and only untuned automatic decoders are stopped for that loss.
Host loss may still stop other automatic decoders, newest first, but never the tuned one,
and it does not keep the tuned decoder from starting again. Only its own sustained loss
(its branch congested while the other branches flowed) stops it, and then it is tried
again after 30 seconds, doubling per consecutive stop to a 4-minute cap (30 s, 60 s,
120 s, 240 s); that history resets after 4 minutes of running without a stop. Starting
it yourself (`POST /api/decoders/:id/start`) clears such a stop at once and re-admits it
on probation: that run is judged like an automatic start, so its own loss can stop it
again. That probation status stays on the decoder until you stop it (a later automatic
restart, retry or stop for loss keeps it). The start answer says what happened: started,
"shed cleared: re-admitted on probation" when it starts at the next evaluation, or "shed
cleared but blocked: <reason>" (the CPU budget is full, the host CPU is over its guard, the
source is dropping samples, or waiting for the source to settle). While the host is
starved, and for 60 seconds after its last host loss that reached the decoder (a drop on a
branch it reads, or loss charged to the whole source; a later drop on one branch alone does
not end it), the decoder status carries `hostBusy` and the verdicts read "host busy: samples were dropped
on several streams" without suggesting a lower sample rate. The "Late drops shed a decoder"
and "Decoder suspension changed" log lines carry `cause` (`host` or `decoder`),
`congestedBranches`, `loopLagP99Ms` and `loopLagMaxMs`.
The budget defaults to half the available CPU capacity, with process and cgroup v1/v2 limits.
The 0.75-core automatic floor is capped at the quota when quota is below 0.75;
see [configuration](CORE-REFERENCE.md#decoder-efficiency-cpu-budget).

A clean completed 30-second probation resets normal consecutive-failure retry backoff
in both admission and the decoder manager. After late-drop shedding, retry history
resets only after a clean run of at least 30 minutes since readmission. A shed or
probation failure before then doubles the delay from 5 to 10 to 20 minutes, capped
at 30 minutes. After that sustained clean run, the next failure starts at 5 minutes.
The tuned decoder's own-loss stops use the shorter schedule above instead.

The dsd-fme scanner link event distinguishes `verified` content from sync-only
fields. DMR color code from voice/IDLE sync is an unverified hint, not an
identity. Only checked data bursts or checked target/source voice link control
can participate in the scanner's two-match identity confirmation. CRC/FEC
failures and `-RAS` output never count. MBCC has no own CRC
(ed1d1d6 `dmr_dburst.c:115–119,627`), so it cannot verify a CC.
MS voice LC does not borrow CC from a pending checked header: the opening CC
precedes slot-type decoding (`dmr_ms.c:676–686`). Checked TG/SRC remain usable
with CC unknown while that header awaits its closing-sync check.
NXDN accepts current CRC-checked ` RAN 03  FACCH2`/UDCH output
(`nxdn_deperm.c:1390–1437`); failure omits RAN, and SACCH/CAC print cached RAN.
A SACCH ` RAN 05 PF 2/4` print counts only when two consecutive frame lines (at
most 500 ms apart) both passed their own SACCH CRC (`PF` digit, not `X`) and
printed the same RAN: the print is the RAN stored by the last passing SACCH.
`Src=1234 - Dst/TG=5678` counts only on the line after a traffic-channel frame
line (`RDCH`/`RTCH`, never `RCCH`) ending in `VCALL`, printed after that FACCH1 or
SACCH-superframe CRC; the same print after `VCALL_ASSGN`, `DCALL_ASSGN`, `TX_REL`
or `DISC` names another channel's call or an ending, and is ignored. A call heard
by RAN alone takes the unit IDs only within 960 ms of its start (three NXDN48
superframes: a tune-in may wait up to five frames and one failed SACCH costs a
superframe); later IDs are another over. A clean frame ending in `TX_REL`,
`TX_REL_EX` or `DISC` ends the call. The older `RAN=` and `TGT=/SRC=` prints are
no longer read.
P25 phase 1 talkgroup and source come from the link control print ` Group Voice
Channel User - Group 4321 Source 1234567`, which both callers (LDU1, TDULC) print
only after the RS(24,12,13) check; ` Unit to Unit Voice Channel User - Target 7
Source 9` gives the source and a target unit (`p25.unitTarget`, no talkgroup). The
NAC on the call is the last sync line whose NID decoded. A `TDU` (or TDULC) ends
the call, so a station keying up again starts a new one. A call that ends before it
was announced still emits its `call_start` first, and a failed NID (`duid:EE`) gives
no NAC.
D-STAR uses the slow-data copy of the header (` RPT 2: … RPT 1: … DST: … SRC: …`,
printed only when its CRC matches; the radio header before it on a `+DSTAR
HEADER` line has no FCS check): MY is the callsign, DST the UR call. A `+DSTAR
HEADER` line ends the ongoing call (a new over, even from the same station or
with a failed slow-data copy), and a different checked MY starts the next
station's call. Without a checked header a D-STAR call starts on two voice syncs
(call-first, below) and carries no callsign until one arrives; the older
`MY:`/`UR:` prints and free-text (`TEXT:`) slow data are never an identity.
dsd-fme checks a slow-data header only in a superframe whose slow data starts
with a header group: with a synthetic spec-shaped stream (data sync in voice
frame 0, a 20-character text message before the header) that is one superframe
in thirteen. Whether real radios yield a callsign therefore depends on their
slow-data cycle; no real radio has been tested.
YSF uses the source callsign of a header/terminator CSD1 (`DST: … SRC: …`) or V/D
type 2 frame (`FN: 2/7 SRC: …`), each printed only after its own DCH CRC; a CSD1
that passed counts even when the CSD2 after it printed `DCH (CRC ERR)`, but such a
line's link stays unverified. A YSF call starts on a frame whose FICH decoded
(`HC|CC FN: n/m`), whatever its DCHs printed; a header frame (`HC`) ends the
ongoing call and the terminator (`TC`) ends the call, also when a DCH failed,
and starts none. Its callsign can follow its start. dPMR TG/Src
prints are not used: dsd-fme marks an ID OK when its CRC failed but two Hamming
words looked correctable, so a dPMR call carries the protocol only and starts on
two identical ID prints at most 240 ms apart (one per FS2 pair, every 160 ms).
**Call lifecycle (call-first).** dsd-fme loses an over's first frame and prints its
identities late (DMR embedded LC needs a whole superframe, half of them are lost in
direct mode), so a call does not wait for them. Voice frame syncs of one protocol
chain while each follows the previous within two of the protocol's sync periods
plus 40 ms (DMR 760 ms, P25 phase 1 HDU/LDU 400 ms, D-STAR 880 ms, YSF 240 ms,
NXDN48 and dPMR 200 ms); a P25 sync printing another NAC starts a new chain. A
DMR sync printing another colour code keeps the chain (an over's first syncs often
print a garbled one) but restarts its count. A call starts on the chain's second
clean frame (a single noise sync starts nothing): two DMR voice syncs of one
colour code (`XX` prints none), a P25 phase 1 or D-STAR voice sync without an error, a YSF frame whose FICH decoded, an NXDN voice frame whose
SACCH passed (two in a row attest the RAN), a dPMR frame whose ID print agrees
with the previous one. Every call is back-dated to its chain's first sync, but at
most four chain windows before the frame that starts it (DMR 3 040 ms, P25
1 600, D-STAR 3 520, YSF 960, NXDN and dPMR 800); talkgroup, source and callsign
attach when the first link control naming them arrives (no second call; a YSF
callsign printed before the start attaches too). When the IDs change while the
syncs keep running, the old call ends at its last line with its own
IDs and the new one is back-dated to the first sync after it. A call that
started on frames alone and spans less than 250 ms is never announced (the weak
metadata suppression). One that still has no identity is announced only after a
checked item (a link control naming it or saying whether it is encrypted, a
checked header) or once its chain holds three clean syncs (DMR: of one colour
code) spanning two superframes less twice the 45 ms print jitter (DMR and P25
630 ms, D-STAR 750 ms), on the line that completes it; it stays back-dated. Two noise syncs (two DMR syncs 700 ms apart, two
D-STAR syncs 420 ms apart) start nothing. Each DMR repeater slot runs its own call, so two busy
slots give two concurrent calls; idle, CSBK and data bursts (a repeater's hang
time) keep no call alive. dsd-fme's lines reach the adapter in clumps about
340 ms apart (stdio buffering, measured on recorded runs): a direct over's syncs
arrive 340 ms apart with an empty clump (680 ms) now and then, a repeater's six
`VC1` to `VC6` bursts of a superframe within a few ms, so no DMR rule measures a
superframe grid on arrival times and no arrival pattern splits a continuous over.
A repeater over's first voice burst prints `VC1*`. A DMR re-key without a
terminator (a new call) is a header burst at least 200 ms after the call's last
voice sync (an LC or slot print is not voice): a voice LC header (`VLC`), a PI
header, or in direct mode a data burst whose slot type failed (`CACH/Burst FEC
ERR`, the first line of a direct over that keyed up with a header; a repeater's
failed CACH names no slot and is not one). The call ends at its last line and the
next starts at the header; with no call on the lane a header begins the next
over's chain, so the call is back-dated to it. Another radio's IDs and the 4 s
timeout end a call too; a re-key with no header, no terminator and the same IDs
(the same radio keying again within one clump) stays one call: a missed split,
never a split over. A P25 HDU after 200 ms is a re-key too. A faded over whose
voice resumes stays one call. A protocol switch (a stray sync of another protocol
included) ends the call at its last line. A call that ends without its terminator (re-key, another radio's IDs,
the 4 s timeout) ends at its last voice line. A DMR terminator (`TLC`) of a call
that has no IDs yet holds its `call_end` up to 105 ms (one 60 ms burst plus the
45 ms jitter) for the terminator's own link control: a `SLOT` line names the
call only if the burst closes clean (no error line before the next sync), a
terminator printed again in that window changes nothing, and the call still ends
at the terminator.
A DMR call that starts before its link control said whether it is encrypted
carries `encryptionKnown: false` on its `call_start` and `voice-call` state: it is
not clear. The first checked link control (DMR TG/SRC with or without `Encrypted`)
makes it known, and an announced call publishes a `voice-call` update with
`encryptionKnown: true` and its identities. A DMR link
control counts as clear only once its burst closed clean: the next DMR sync (of
either slot) with no error line before it; a line with an error, a sync loss or
4 s without a sync leave the call unknown (an `Encrypted` one mutes it at once).

P25, NXDN, dPMR and ProVoice calls are clear only on a positive clear print of the
call itself; every one starts with `encryptionKnown: false`:

| Protocol    | Positive clear print (sets `encryptionKnown: true`)                                                                                                                                                         | Privacy prints (encrypted for good)                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| P25 phase 1 | An error-free `LDU2 ALG ID: 0x80 KEY ID: 0x0000` line whose superframe's own LDU1 link control (checked) named the call (dsd-fme prints the ALG of every LDU2 that decoded; the LDU2 carries no IDs)        | An ALG ID other than `0x80` or `0x00`, ` ENC`, ` Encrypted` (LCW service options), `LCW Protected` |
| P25 phase 2 | None: dsd-fme prints an ALG only when it is neither `0x80` nor `0x00`, so a phase 2 call is never known clear                                                                                               | Any ALG ID line other than `0x80` / `0x00`, ` Encrypted`                                           |
| NXDN48 / 96 | A CRC-checked VCALL whose `Src=… - Dst/TG=…` are the call's own, followed by a line that is not a cipher print (dsd-fme prints the cipher type and key right after whenever the 2-bit cipher type is not 0) | `Scrambler/DES/AES - Key ID`, `ENC;`, `Encrypted`                                                  |
| dPMR        | None: dsd-fme prints ` Scrambler` for encryption mode 3 only and nothing for modes 1 and 2                                                                                                                  | ` Scrambler`                                                                                       |
| ProVoice    | None: no privacy field is printed                                                                                                                                                                           | None                                                                                               |
| D-STAR, YSF | No privacy field exists (no cipher bit in the D-STAR header flags or the YSF FICH; their scramblers are data whitening): no `encryptionKnown` field, clear                                                  | None                                                                                               |

A privacy print also counts on an errored line, and one printed while no call of
that protocol runs marks the next call that starts within 4 s encrypted, unless a
terminator (P25 `TDU`/`TDULC`, NXDN `TX_REL`/`DISC`), a switch to another protocol
or a decoder restart comes first. A clear print never carries over: an earlier
call's, or one printed for other IDs, proves nothing for the next call. The LCW's
service options without `Encrypted`, or a clear ALG on a `src: … tg: …` print,
prove nothing either. After a P25 header (`HDU`, the next over) or an LDU1 whose
link control failed, an LDU2 clear print proves nothing until a checked LDU1 link
control names a call, and then only for that call.

Whatever the evidence says, every call of every protocol is published:
`call_start` and `call_end` with its talkgroup, source and times exist for a
P25 phase 2, dPMR or ProVoice call exactly as for a clear one. Privacy and
evidence set only `encrypted`, `encryptionKnown`, live playback and the
recording.

What this means in use:

- **Live audio.** dPMR, P25 phase 2 and ProVoice calls are never known clear, so
  they stay silent live and are never recorded. A P25 phase 1 or NXDN call is
  muted until its own clear print: its audio starts about 0.3 to 0.5 s late (one
  superframe, or the VCALL frame), and the whole call stays silent if that print
  never decodes.
- **Scanner.** A scanner probe records such a call as encrypted in its evidence
  (no clear recording), so these calls read as encrypted in scanner evidence.
- **Recordings.** dsd-fme's own per-call files (`-7 <dir> -P`) of P25, NXDN,
  dPMR, ProVoice (named `EDACS_`) and M17 are never listed in Recordings, served,
  downloaded or linked to their Activity row, in a dsd-fme directory or a scanner
  `dv` folder: the file name does not carry the call's clear print. The files stay
  on disk under the usual retention. Their known clear calls are kept by the
  digital-voice call recorder instead ([DIGITAL-VOICE.md](DIGITAL-VOICE.md)).
  D-STAR and YSF dsd-fme files are listed and served as before; M17 files are
  not (its LSF carries an encryption type, and dsd-fme prints no clear proof).
- **Finding the file.** dsd-fme names a call's file when it closes it, so WaveKit
  looks the file up after the call ends, off the event loop: a first look at once,
  then up to 5 more 200 ms apart, every look of every call one at a time, at most
  20 000 directory entries each. The call's `call_end` never carries the file; a
  second `call_end` with `flags.wavFileUpdate: true` and `wavFile` follows when it
  is found (since 2026-11-23; before, a file already there rode on the first
  `call_end`).
- **Activity.** A call file is linked only when the row's own `call_end` proves
  it clear and not encrypted: `encryptionKnown: true` with `clearEvidence: true`
  (the call's own clear print) for P25 phase 1 and NXDN, `encryptionKnown: true`
  for DMR, never for P25 phase 2, dPMR, ProVoice, EDACS or M17, and the same check runs again when a row is read (REST and
  WebSocket): a link stored before this rule, for a call that was not known
  clear (or `encryptionKnown: true` without `clearEvidence`), loses its play
  control; the row stays. DMR per-call
  recordings are off for now (`DMR_RECORDING_LINK_ENABLED` in
  `src/decoders/builtin/dmr-recording-gate.ts`): until DMR clearance is trusted, no
  DMR call file is written by the call recorder, listed, served or linked, clear or
  not. The recordable protocols are an allow-list (P25, NXDN, YSF, D-STAR, dPMR,
  ProVoice, EDACS, M17); a dsd-fme file name without a known protocol is refused
  too and stays on disk. Noise that prints
  three clean DMR syncs of one colour code over two superframes starts such a call;
  it never learns its encryption, so it stays muted and unrecorded. YSF and D-STAR
  calls carry no `encryptionKnown` field (no privacy field to read).
  Calls of the catalogue's `auto` mode (`-fa`) cover DMR, P25, YSF, D-STAR and
  X2-TDMA; dsd-fme turns NXDN and dPMR off in that mode, so they need a decoder with
  `mode: nxdn`, `nxdn48` or `dpmr`.
  Other protocols also require a known checked print format;
  unknown formats default to unverified. Activity placement protection follows the
  same clean check: only `verified: true`, `crcErr: false`, absent/zero `fecErrs`
  renew it. Each clean line protects the exact running placement strictly before
  `lastCleanSyncMonoMs + max(60,000, dwellMs × max(1, maxMovesPerMinute))`
  (default 120 seconds). Weak hints and failed checks never extend the initial dwell
  (default 20 seconds); at/past expiry, normal no-sync demotion and the shared move
  budget apply. Recent checked voice decodes override non-voice exclusion; exclusion
  associates only within one quarter of the channel width (3,125 Hz at 12,500 Hz),
  so adjacent paging does not remove confirmed DMR. See [Digital voice identity checks](SCANNER.md#digital-voice-identity-checks).

### dsd-fme receive filter

dsd-fme decides each 4FSK symbol from the mean of a few samples and, before a
sync, reads the FM discriminator output unfiltered, so the discriminator's noise
above the 4FSK band (it rises with frequency up to the channel edge) reaches the
decision. The adapter therefore filters the discriminator output in its sox WAV
wrapper (`receiveFilter`, default `true`; `false` restores the unfiltered chain):

| Mode                                 | Filter                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `auto`, `dmr`, `p25`, `ysf`, `dstar` | Linear-phase low-pass, flat to 2.5 kHz, stopped from 3.5 kHz (`sinc -t 1000 -3000`) |
| `nxdn48`                             | NXDN receive filter: root raised cosine 0.2 times sin x / x at 2400 symbols/s       |
| `dpmr`                               | Linear-phase low-pass, flat to 1.05 kHz, stopped from 1.55 kHz                      |
| `nxdn` (NXDN96), `provoice`          | None                                                                                |

The 4800 symbols/s low-pass passes every transmit filter in use there (P25 raised
cosine 0.2 with or without its x / sin x shaping filter, DMR and YSF root raised
cosine 0.2, D-STAR GMSK). A matched root raised cosine cut more noise but made
dsd-fme lose YSF frame sync on strong signals, and for dPMR it lost more frames
with a carrier frequency error, so neither uses one. NXDN transmitters add
x / sin x, which only the matched NXDN filter undoes. NXDN96 stays unfiltered
until it is measured: the synthetic NXDN96 transmission decoded only with a
roll-off of 0.5, which the low-pass cuts. P25 phase 2 (6000 symbols/s) is wider
than the low-pass; in `auto` dsd-fme looks for it at the 4800 symbols/s timing and
switches only on a trunking grant, so it was not measured. A low-pass is left out
when the sox input rate is below twice its stop edge (7 kHz, or 3.1 kHz for dPMR),
which only a raw capture slower than that gives. The sox effect costs
about 0.1 % of a desktop core per decoder (Raspberry Pi not measured).

`tests/integration/dsd-fme-margin.test.ts` measures per protocol, CNR (in
12.5 kHz) and carrier frequency error, with each air interface's own transmit
filter (`scripts/fixtures/fsk-iq.mjs` `AIR_SHAPES`) and a DMR repeater downlink
generator (`scripts/fixtures/dmr-4fsk.mjs`). The frame error rate counts the frames
whose CRC- or FEC-checked field dsd-fme did not print as passing; the symbol error
rate compares dsd-fme's symbol decisions (its `-c` capture) with the sent symbols
over the stretches where they align (at most 25 % mismatches), so it understates
errors at low CNR. Each seed delays the symbols by a different fraction of a symbol
(a transmitter's clock has no fixed phase to the receiver's samples): dsd-fme corrects
timing only by whole samples, and without noise it lost 0 to 26 % of YSF frames
depending on that phase alone, with or without a filter, so a fixed phase measures
one lucky or unlucky receiver. `WAVEKIT_MARGIN_PHASE` fixes it,
`WAVEKIT_MARGIN_RATE=2400000` uses the 2.4 Msps capture instead of 1.024 Msps. A
wider low-pass (-6 dB at 3.5 or 4 kHz) left this YSF floor (3 to 6 % at 30 to 40 dB)
as it was and lost part of the gain at 10 dB. It runs only with `WAVEKIT_MARGIN=1`,
on the host's dsd-fme or,
with `WAVEKIT_SYNTH_IMAGE=<image>`, the core image's:

```bash
WAVEKIT_MARGIN=1 WAVEKIT_SYNTH_IMAGE=<core image> \
  pnpm exec vitest run --maxWorkers=1 tests/integration/dsd-fme-margin.test.ts
```

Measured with a host dsd-fme build older than the image's pinned one (the image
has not been measured yet), at CNR 10 dB and no frequency error, the filter took
P25 from 100 % of link controls lost to 7 %, YSF from 85-98 % of FICH frames lost to
31-56 %, D-STAR from 100 % to 25 % of superframes, standard-shaped NXDN48 from 99 %
to 14 % of SACCH frames, dPMR from 15 % to 6 % of control channels and DMR from
44 % to 37 % of link controls (aligned symbol errors 6.0 % to 3.0 %). A recorded
on-air DMR transmission decodes identically. A carrier frequency error of 600 Hz
still loses most YSF frames: a DC blocker on the discriminator would fix that but
mutes DMR direct-mode bursts (the recorded transmission decodes nothing), so the
channel corrects the frequency instead ([below](#dsd-fme-carrier-frequency-correction)).

### dsd-fme carrier frequency correction

A handheld's or repeater's crystal and the receiver's ppm error often put a carrier
a few hundred Hz off its channel, which the FM discriminator turns into a DC offset
on every 4FSK symbol. A channelised dsd-fme (`useChannelizer` with the core
channelizer) therefore asks its channel for a carrier frequency correction of up to
2 kHz (`carrierCorrection`, default `true`; `false` turns it off). 2 kHz is what
the 12.5 kHz channel allows: it is flat to ±6.25 kHz and 4800 symbols/s 4FSK
occupies about ±4.25 kHz. The raw-IQ csdr chain has no correction.

`wavekit-chan` runs it on the channel output (`native/wavekit-chan/src/afc.rs`),
only while a modulated carrier is present, and so that dsd-fme never sees the
correction change during a call:

- it measures on its own copy of the uncorrected samples, low-passed to 6.3 kHz so
  that an adjacent 12.5 kHz channel does not reach the estimate (a neighbour 10 dB
  stronger moved it by at most 20 Hz; 250 Hz without the filter). There is no loop,
  so it never chases the modulation;
- each 5 ms block is a gap (its envelope is not nearly constant, `(Σ|z|²)² / (N·Σ|z|⁴)`
  under 0.68, or its power is 6 dB below the transmission's), unmodulated (its phase
  turns alike over 4 and 8 samples: a spur, a birdie, the centre leak, an unkeyed
  carrier or a long run of one symbol, none of which counts) or modulated. A
  modulated block 6 dB above the transmission's power starts a new transmission
  (another radio keyed up);
- the target is the midpoint of the outer frequency levels (the 5 % and 95 % points
  of a power-weighted histogram of the instantaneous frequency), not the mean: the
  mean follows the data, the outer levels do not, and dsd-fme reads its own centre
  from the extremes of a sync. On the synthetic signals that left DMR within 30 Hz
  of the carrier, where the mean was 100 to 150 Hz off;
- it decides each transmission's correction once, from its first 85 ms, and keeps it
  to the end of the transmission: dsd-fme averages its symbol levels over many syncs,
  so any change it can see during a call costs frames (a DMR call corrected 280 ms in
  lost 11-19 % of link controls, an NXDN48 call corrected 40 ms in 35-43 % against
  18 % uncorrected, measured). The output is delayed by 90 ms, so the decision applies
  from the transmission's first sample, and within a transmission there is no step;
- the correction is the target if at least 200 Hz plus 2.5 standard deviations of
  the data's own mean off (380 Hz at the decision), else 0 Hz. Smaller errors are left
  alone: uncorrected, ±300 Hz cost DMR no frames;
- a transmission that has had a gap by then (TDMA bursts: DMR direct mode, whose
  bursts the 85 ms always span) is never corrected: correcting a +600 Hz direct-mode
  call, even with the step in a gap and the residual near 0 Hz, doubled its symbol
  errors, while the uncorrected offset cost nothing;
- it holds through gaps shorter than 250 ms (a direct-mode radio keys a 27.5 ms burst
  every 60 ms) and resets after a longer one, on a retune to another frequency and on
  an input gap (a capture recentre keeps it: the signal is the same). A radio keying
  up 6 dB stronger than the transmission was when its correction was decided starts
  its own, corrected from its first block (the previous radio's tail keeps its own; a
  fade that recovers is not taken for one). Two cases still change the correction
  under a carrier: a radio of about the same power keying within 250 ms of the first
  continues its transmission and keeps its correction; a weaker one goes out with the
  first one's correction, then 0 Hz from the end of the hang, then its own.

The mixer is phase continuous and returns to phase 0 when a transmission ends. The
90 ms lookahead is part of the channel's reported group delay; it starts with 90 ms of
zeros whenever the stage starts afresh (a channel open, an input gap, a retune to
another frequency, so also each scanner probe), and the last 90 ms of a stream are not
delivered. A
`wavekit-chan` older than the correction does not offer `afc` in its `ready` line;
the core then opens dsd-fme's channels without it (one warning per source).
Recorded-capture replay (`wavekit-iqcap replay`, scanner snapshot replay) runs
without the correction, so a capture with a carrier offset may decode worse there
than on the live channel. The cost is about 100 ns per output sample, 0.5 % of a
desktop core per 48 kHz channel, next to 4 % for the channel itself (fastest block,
`native/wavekit-chan/examples/chan_bench.rs`, Mac i5, load average 80; Raspberry Pi
not measured).

The margin harness above measures it: `before` is the receive filter alone,
`after` adds the correction, and each cell also shows the residual carrier offset
dsd-fme still sees (aligned on the channel's group delay), which does not depend on
the dsd-fme build. `DMR (direct)` is a direct-mode call (MS syncs, keyed bursts). On
the host's dsd-fme build, three seeds:

- DMR downlink: no cell worse than before at 0, ±300, ±600 and ±1000 Hz and 10 to
  30 dB CNR; better at ±1000 Hz (10 dB: 40.7 % of link controls lost to 29.6 %,
  18.5 % to 11.1 %) and −600 Hz (10 dB: 29.6 % to 25.9 %). Residual −75 to +13 Hz;
  ±300 Hz stays uncorrected.
- DMR direct mode: uncorrected, as before at every offset (cells within one frame:
  the 90 ms delay; over nine seeds at +300 Hz and 10 dB 65.4 % against 66.7 %).
- At −600 Hz YSF went from 100 % of frames lost to 4.9 % at 30 dB (13.6 % at 15 dB,
  51 % at 10 dB), D-STAR at 10 dB from 100 % to 33 %, dPMR from 15-33 % to 6.3 %,
  NXDN48 from 7-49 % to 0-24 %; at +600 Hz YSF at 10 dB from 53 % to 33 % and at
  15 dB from 25 % to 9.9 %, dPMR from 15-35 % to 6-15 % and D-STAR at 10 dB from
  100 % to 38 %. The residual is −100 to +80 Hz, the target being decided from 85 ms
  of data. That build's NXDN48 results move by up to 25 points between runs of the
  same input, so its cells are not comparisons.

To run the full matrix in the core image:

```bash
WAVEKIT_MARGIN=1 WAVEKIT_SYNTH_IMAGE=<core image> \
  WAVEKIT_MARGIN_SIGNALS="DMR,DMR (direct),P25 (C4FM),YSF (C4FM),NXDN48,dPMR,D-STAR" \
  WAVEKIT_MARGIN_ERROR_HZ=0,300,-300,600,-600,1000,-1000 \
  pnpm exec vitest run --maxWorkers=1 tests/integration/dsd-fme-margin.test.ts
```

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
For caller-supplied replay input, DecoderManager preserves `inputSampleRate`
(105 000 Hz for dumpvdl2, 250 000 Hz for lora-meshtastic) rather than replacing
it with the live source rate. Configured instances reading the live source still
receive that source’s sample rate.
Automatic scanner trials also need probe-pool decoder admission and confirmation;
see [scanner replay](SCANNER.md#iq-capture-on-detection).
