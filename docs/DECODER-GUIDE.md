# Adding Decoders to WaveKit

This guide explains how to add new signal decoders to WaveKit.

## Decoder Integration Patterns

WaveKit supports three integration patterns:

| Pattern              | Description                         | Examples             |
| -------------------- | ----------------------------------- | -------------------- |
| **Pure Consumer**    | Receives audio via stdin            | dsd-fme, multimon-ng |
| **Network Producer** | Runs as service with network output | readsb, AIS-catcher  |
| **External SDR**     | Controls its own SDR hardware       | acarsdec, dumpvdl2   |

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

Add to `src/decoders/registry.ts`:

```typescript
import { MyDecoder, MY_DECODER_CAPS } from "./builtin/my-decoder.js"

// In the registerBuiltinDecoders function:
registry.register(
	"my-decoder",
	(config, logger) => new MyDecoder(config, logger),
	MY_DECODER_CAPS,
)
```

### Step 3: Add Configuration Schema

Add to `src/config.ts`:

```typescript
const MyDecoderOptionsSchema = z.object({
	mode: z.enum(["auto", "mode1", "mode2"]).default("auto"),
	verbosity: z.number().int().min(0).max(3).optional(),
})

// Add to DecoderConfigSchema union
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

WaveKit automatically restarts decoders when the source sample rate changes (via TunerRelay). Your decoder does not need special handling—it will be gracefully stopped and restarted with the new rate.

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
// In src/decoders/registry.ts
import { HfdlDecoder, HFDL_DECODER_CAPS } from "./builtin/hfdl.js"

registry.register(
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

1. Check if binary exists: `docker exec wavekit which my-decoder`
2. Check permissions: `docker exec wavekit ls -la /usr/local/bin/my-decoder`
3. Check logs: `make dev-stack-logs | grep my-decoder`

### No output being parsed

1. Run decoder manually: `docker exec wavekit my-decoder --help`
2. Check output format matches parser
3. Add debug logging to parseOutput

### High CPU usage

1. Check if decoder is in a restart loop
2. Verify input format matches decoder expectations
3. Consider adding rate limiting
