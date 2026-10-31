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
   receiving. dsd-fme also considers scanner-observed energy centres when no explicit
   decoder channels are configured, including channels absent from the protocol band plan.
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
`rx_rssi` and `rx_snr` are 0, because gr-lora_sdr does not measure them.

The decoder demodulates only the capture centre (`reach: centre`). Tune the centre to the
channel, for example 869.525 MHz for EU_868 LongFast. A frame 200 kHz off centre does
not decode. The DC spike at the centre does not stop decoding: a synthetic frame
decoded at +10 and −5 dB SNR with or without one. The fixtures and tests are described
in `fixtures/lora/README.md`.

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
   `no-channel-selected`) and the channelizer (`channelizer-unavailable`).
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
branch: overflow charged to the source as a whole, CPU over the guard, or host loss on
another decoder's branch stops the newest other automatic decoder instead, at most one per
60-second clear window on each source (one host-wide for CPU). Under sustained CPU load the
tuned decoder is stopped only once that window has closed with nothing else left to stop,
and loss already spent on such a stop does not stop a second decoder through late drops
on that source until the window has closed. After a stop for CPU, host-attributed drops on
any source are that same load and stop nobody else until that stop's own 60-second window
has closed; stops for other loss inside it do not extend it. Other
fresh drops on another decoder's own branch within that window are new loss and still
stop it. A decoder's own branch drops count as
its own even when overflow with no holder known falls in the same sample.
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
unknown formats default to unverified. Activity placement protection follows the
same clean check: only `verified: true`, `crcErr: false`, absent/zero `fecErrs`
renew it. Each clean line protects the exact running placement strictly before
`lastCleanSyncMonoMs + max(60,000, dwellMs × max(1, maxMovesPerMinute))`
(default 120 seconds). Weak hints and failed checks never extend the initial dwell
(default 20 seconds); at/past expiry, normal no-sync demotion and the shared move
budget apply. Recent checked voice decodes override non-voice exclusion; exclusion
associates only within one quarter of the channel width (3,125 Hz at 12,500 Hz),
so adjacent paging does not remove confirmed DMR. See [Digital voice identity checks](SCANNER.md#digital-voice-identity-checks).

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
