# WaveKit API Reference

WaveKit exposes a REST API and WebSocket endpoint for control and real-time monitoring.

## Base URL

- **REST API**: `http://localhost:9000`
- **WebSocket**: `ws://localhost:9000/ws`
- **Audio Stream**: `tcp://localhost:8080`
- **Live Audio Stream**: `http://localhost:8081/stream`

## REST Endpoints

### Health & Status

#### GET /health

Quick liveness check.

```bash
curl http://localhost:9000/health
```

**Response** (200 OK):

```json
{
	"status": "ok",
	"uptime": 3600
}
```

**Response** (503 Service Unavailable):

```json
{
	"status": "unhealthy",
	"error": "No sources connected"
}
```

#### GET /health/ready

Readiness probe for orchestration systems.

```bash
curl http://localhost:9000/health/ready
```

**Response** (200 OK):

```json
{
	"ready": true,
	"components": {
		"api": "up",
		"sources": "up",
		"decoders": "up"
	}
}
```

#### GET /api/status

Full system status including sources, decoders, audio output, and tuner relay (if enabled).

```bash
curl http://localhost:9000/api/status
```

**Response**:

```json
{
	"uptime": 3600,
	"version": "1.0.0",
	"sources": [
		{
			"id": "sdrpp-main",
			"type": "sdrpp-network",
			"connected": true,
			"bytesReceived": 847000000,
			"dataRate": 192000,
			"reconnectAttempts": 0
		}
	],
	"decoders": [
		{
			"id": "dsd-main",
			"type": "dsd-fme",
			"running": true,
			"health": "running",
			"pid": 1234,
			"uptime": 3590,
			"stats": {
				"bytesIn": 423000000,
				"eventsOut": 847,
				"errors": 2
			}
		}
	],
	"audio": {
		"outputPort": 8080,
		"clientsConnected": 1,
		"format": "S16LE",
		"sampleRate": 48000
	},
	"tunerRelay": {
		"enabled": true,
		"listening": true,
		"host": "0.0.0.0",
		"port": 1234,
		"sourceId": "rtl-pi",
		"clientsConnected": 1,
		"controlPolicy": "exclusive",
		"bytesSent": 421000000,
		"bytesReceived": 120,
		"lastFrequency": 446524920,
		"lastSampleRate": 2048000,
		"lastCommand": "set-frequency",
		"lastCommandAt": "2024-05-21T03:12:01.123Z",
		"lastCommandValue": 446524920,
		"commandHistoryLimit": 200,
		"commandStats": [
			{
				"id": 1,
				"name": "set-frequency",
				"count": 6,
				"lastValue": 446524920,
				"lastSeenAt": "2024-05-21T03:12:01.123Z"
			}
		],
		"commandHistory": [
			{
				"id": 1,
				"name": "set-frequency",
				"value": 446524920,
				"at": "2024-05-21T03:12:01.123Z",
				"clientId": "client-1",
				"clientRemote": "192.168.1.50:50522"
			}
		]
	}
}
```

### Sources

#### GET /api/sources

List all configured sources.

```bash
curl http://localhost:9000/api/sources
```

**Response**:

```json
[
	{
		"id": "sdrpp-main",
		"type": "sdrpp-network",
		"host": "192.168.1.69",
		"port": 5555,
		"connected": true,
		"bytesReceived": 847000000,
		"dataRate": 192000,
		"caps": {
			"kind": "audio_pcm",
			"sampleRate": 48000,
			"format": "FLOAT32LE",
			"exclusive": false
		}
	}
]
```

### Tuner

#### GET /api/tuner

List tuner states for all RTL-TCP sources.

Relay-driven RTL-TCP commands (from SDR++ via the tuner relay) update these
states and will automatically switch control mode to `external` while the relay
has an active control client.

```bash
curl http://localhost:9000/api/tuner
```

**Response**:

```json
[
	{
		"sourceId": "rtl-pi",
		"frequency": 144800000,
		"sampleRate": 2400000,
		"gainMode": "agc",
		"gain": 0,
		"ppm": 0,
		"agcMode": true,
		"biasTee": false,
		"directSampling": "off",
		"offsetTuning": false,
		"ifGain": 0,
		"tunerIfGain": null,
		"testMode": false,
		"controlMode": "internal",
		"commandCount": 12,
		"lastCommandAt": "2024-05-21T03:12:01.123Z"
	}
]
```

#### GET /api/tuner/:sourceId

Get tuner state for a single source.

```bash
curl http://localhost:9000/api/tuner/rtl-pi
```

#### POST /api/tuner/:sourceId/frequency

Set center frequency.

```bash
curl -X POST http://localhost:9000/api/tuner/rtl-pi/frequency \
  -H "Content-Type: application/json" -d '{"hz":144800000}'
```

#### POST /api/tuner/:sourceId/control-mode

Release control to SDR++ (`external`) or reclaim (`internal`).

```bash
curl -X POST http://localhost:9000/api/tuner/rtl-pi/control-mode \
  -H "Content-Type: application/json" -d '{"mode":"external"}'
```

#### Additional tuner endpoints

- `POST /api/tuner/:sourceId/gain` — Set manual gain (`{ "tenthsDb": 400 }`)
- `POST /api/tuner/:sourceId/gain-mode` — `manual` or `agc`
- `POST /api/tuner/:sourceId/sample-rate` — Set sample rate
- `POST /api/tuner/:sourceId/ppm` — Set PPM correction
- `POST /api/tuner/:sourceId/agc` — RTL2832 AGC toggle
- `POST /api/tuner/:sourceId/bias-tee` — Bias-T power toggle
- `POST /api/tuner/:sourceId/direct-sampling` — `off` / `i` / `q`
- `POST /api/tuner/:sourceId/offset-tuning` — Offset tuning toggle
- `POST /api/tuner/:sourceId/if-gain` — IF gain value
- `POST /api/tuner/:sourceId/tuner-if-gain` — IF stage/gain pair
- `POST /api/tuner/:sourceId/test-mode` — Test mode toggle
- `POST /api/tuner/:sourceId/rtl-xtal` — RTL XTAL frequency
- `POST /api/tuner/:sourceId/tuner-xtal` — Tuner XTAL frequency
- `POST /api/tuner/:sourceId/tuner-gain-index` — Gain index value
- `PATCH /api/tuner/:sourceId/config` — Bulk update

### Tuner Relay

#### GET /api/tuner-relay

Get RTL-TCP tuner relay status and connection details.

```bash
curl http://localhost:9000/api/tuner-relay
```

**Response**:

```json
{
	"enabled": true,
	"listening": true,
	"host": "0.0.0.0",
	"port": 1234,
	"sourceId": "rtl-pi",
	"sourceConnected": true,
	"sourceKind": "iq",
	"sourceFormat": "U8_IQ",
	"compatibility": "ok",
	"clientsConnected": 1,
	"controlClientRemote": "192.168.1.50:50522",
	"controlPolicy": "exclusive",
	"bytesSent": 421000000,
	"bytesReceived": 120,
	"lastFrequency": 446524920,
	"lastSampleRate": 2048000,
	"lastCommand": "set-frequency",
	"lastCommandAt": "2024-05-21T03:12:01.123Z",
	"lastCommandValue": 446524920,
	"commandHistoryLimit": 200,
	"commandStats": [
		{
			"id": 1,
			"name": "set-frequency",
			"count": 6,
			"lastValue": 446524920,
			"lastSeenAt": "2024-05-21T03:12:01.123Z"
		}
	],
	"commandHistory": [
		{
			"id": 1,
			"name": "set-frequency",
			"value": 446524920,
			"at": "2024-05-21T03:12:01.123Z",
			"clientId": "client-1",
			"clientRemote": "192.168.1.50:50522"
		}
	]
}
```

### Live Audio

#### GET /api/live-audio/status

Get live demodulator status.

```bash
curl http://localhost:9000/api/live-audio/status
```

**Response**:

```json
{
	"enabled": true,
	"running": true,
	"sourceId": "rtl-pi",
	"sourceConnected": true,
	"sourceIqSampleRate": 2400000,
	"config": {
		"enabled": true,
		"sourceId": "rtl-pi",
		"httpPort": 8081,
		"modulation": "nfm",
		"bandwidth": 12500,
		"squelch": 0,
		"noiseReduction": "off",
		"lowPass": 0,
		"highPass": 0,
		"gain": 10,
		"deEmphasis": false,
		"deEmphasisTau": 50,
		"audioFormat": "s16le",
		"iqDcBlock": true
	},
	"effectiveSampleRate": 25000,
	"decimationFactor": 96,
	"httpUrl": "http://localhost:8081/stream",
	"clientCount": 1,
	"bytesStreamed": 1234567,
	"pipelineHealth": "running"
}
```

#### POST /api/live-audio/start

Start live demodulation.

```bash
curl -X POST http://localhost:9000/api/live-audio/start
```

**Response**:

```json
{ "success": true }
```

#### POST /api/live-audio/stop

Stop live demodulation.

```bash
curl -X POST http://localhost:9000/api/live-audio/stop
```

**Response**:

```json
{ "success": true }
```

#### PATCH /api/live-audio/config

Update live demodulator configuration (hot-restart pipeline).

```bash
curl -X PATCH http://localhost:9000/api/live-audio/config \
  -H "Content-Type: application/json" \
  -d '{
    "modulation": "am",
    "bandwidth": 10000,
    "gain": 8.0
  }'
```

**Response**:

Returns the updated status (same schema as `/api/live-audio/status`).

#### GET /api/live-audio/presets

Get recommended presets per modulation.

```bash
curl http://localhost:9000/api/live-audio/presets
```

**Response**:

```json
{
	"nfm": { "bandwidth": 12500, "deEmphasis": false },
	"wfm": { "bandwidth": 150000, "deEmphasis": true, "deEmphasisTau": 50 },
	"am": { "bandwidth": 10000, "deEmphasis": false },
	"usb": { "bandwidth": 2400, "deEmphasis": false },
	"lsb": { "bandwidth": 2400, "deEmphasis": false },
	"dsb": { "bandwidth": 6000, "deEmphasis": false },
	"cw": { "bandwidth": 500, "deEmphasis": false },
	"raw": { "bandwidth": 0, "deEmphasis": false }
}
```

#### POST /api/sources

Add a new source.

```bash
curl -X POST http://localhost:9000/api/sources \
  -H "Content-Type: application/json" \
  -d '{
    "id": "rtl-pi",
    "type": "rtl_tcp",
    "host": "192.168.1.100",
    "port": 1234,
    "caps": {
      "kind": "audio_pcm",
      "sampleRate": 48000,
      "format": "S16LE",
      "exclusive": false
    }
  }'
```

**Response** (201 Created):

```json
{
	"id": "rtl-pi",
	"type": "rtl_tcp",
	"connected": false,
	"message": "Source added, connecting..."
}
```

#### DELETE /api/sources/:id

Remove a source.

```bash
curl -X DELETE http://localhost:9000/api/sources/rtl-pi
```

**Response** (200 OK):

```json
{
	"id": "rtl-pi",
	"message": "Source removed"
}
```

### Decoders

#### GET /api/decoders

List all decoders and their status.

```bash
curl http://localhost:9000/api/decoders
```

**Response**:

```json
[
	{
		"id": "dsd-main",
		"type": "dsd-fme",
		"enabled": true,
		"running": true,
		"health": "running",
		"pid": 1234,
		"uptime": 3590,
		"sourceId": "sdrpp-main",
		"stats": {
			"bytesIn": 423000000,
			"eventsOut": 847,
			"errors": 2
		},
		"restartCount": 0,
		"version": "2.0.0"
	},
	{
		"id": "readsb",
		"type": "readsb",
		"enabled": true,
		"running": true,
		"health": "running",
		"pid": 1235,
		"uptime": 3585,
		"stats": {
			"bytesIn": 0,
			"eventsOut": 12847,
			"errors": 0
		},
		"restartCount": 0,
		"version": "3.14.1"
	}
]
```

#### GET /api/decoders/:id

Get status of a specific decoder.

```bash
curl http://localhost:9000/api/decoders/dsd-main
```

**Response**:

```json
{
	"id": "dsd-main",
	"type": "dsd-fme",
	"enabled": true,
	"running": true,
	"health": "running",
	"pid": 1234,
	"uptime": 3590,
	"sourceId": "sdrpp-main",
	"stats": {
		"bytesIn": 423000000,
		"eventsOut": 847,
		"errors": 2
	},
	"lastOutput": {
		"timestamp": "2026-01-09T14:23:45.123Z",
		"decoder": "dsd-main",
		"type": "call",
		"data": {
			"talkgroup": 1234,
			"source": 5678,
			"mode": "DMR"
		}
	}
}
```

#### POST /api/decoders/:id/start

Start a decoder.

```bash
curl -X POST http://localhost:9000/api/decoders/dsd-main/start
```

**Response** (200 OK):

```json
{
	"id": "dsd-main",
	"running": true,
	"pid": 1234,
	"message": "Decoder started"
}
```

#### POST /api/decoders/:id/stop

Stop a decoder.

```bash
curl -X POST http://localhost:9000/api/decoders/dsd-main/stop
```

**Response** (200 OK):

```json
{
	"id": "dsd-main",
	"running": false,
	"message": "Decoder stopped"
}
```

#### POST /api/decoders/:id/restart

Restart a decoder.

```bash
curl -X POST http://localhost:9000/api/decoders/dsd-main/restart
```

**Response** (200 OK):

```json
{
	"id": "dsd-main",
	"running": true,
	"pid": 1235,
	"message": "Decoder restarted"
}
```

#### PATCH /api/decoders/:id

Update decoder configuration.

```bash
curl -X PATCH http://localhost:9000/api/decoders/dsd-main \
  -H "Content-Type: application/json" \
  -d '{
    "options": {
      "mode": "dmr"
    }
  }'
```

**Response** (200 OK):

```json
{
	"id": "dsd-main",
	"message": "Configuration updated, restart required"
}
```

## WebSocket API

### Connection

```javascript
const ws = new WebSocket("ws://localhost:9000/ws")

ws.onopen = () => {
	// Subscribe to channels
	ws.send(
		JSON.stringify({
			type: "subscribe",
			channels: [
				"decoders",
				"sources",
				"metrics",
				"health",
				"fanout",
				"live-audio",
				"resources",
				"tuner",
			],
		}),
	)
}

ws.onmessage = event => {
	const msg = JSON.parse(event.data)
	console.log(msg.type, msg.data)
}
```

### Client Messages

#### Subscribe

```json
{
	"type": "subscribe",
	"channels": [
		"decoders",
		"sources",
		"metrics",
		"health",
		"fanout",
		"live-audio",
		"resources",
		"tuner"
	]
}
```

#### Unsubscribe

```json
{
	"type": "unsubscribe",
	"channels": ["metrics"]
}
```

### Server Messages

#### decoder:output

Emitted when a decoder produces output.

```json
{
	"type": "decoder:output",
	"channel": "decoders",
	"data": {
		"decoderId": "dsd-main",
		"output": {
			"timestamp": "2026-01-09T14:23:45.123Z",
			"decoder": "dsd-main",
			"type": "call",
			"data": {
				"talkgroup": 1234,
				"source": 5678,
				"mode": "DMR",
				"duration": 12.5
			}
		}
	}
}
```

The `output.type` field is the discriminator — switch on it to route per-decoder payloads. Known values include `call`, `call_start`, `call_end`, `signal`, `aircraft`, `ship`, `acars`, `vdl2`, `aprs`, `meshtastic`, plus generic `sync`, `decode`, `error`, `stats`.

##### Meshtastic packet (type: `meshtastic`)

Emitted by the `lora-meshtastic` decoder. `from`/`to`/`id` are 32-bit unsigned ints; `to === 0xFFFFFFFF` (4294967295) marks broadcast destinations. `payloadB64` is the AES-CTR-decrypted Meshtastic `Data.payload` (decode with the per-portnum protobuf — e.g. portnum `1` is `TEXT_MESSAGE_APP` UTF-8 text). `viaMqtt` and `priority` are present only when set on the originating frame.

```json
{
	"type": "decoder:output",
	"channel": "decoders",
	"data": {
		"decoderId": "meshtastic-eu",
		"output": {
			"timestamp": "2026-05-15T14:23:45.123Z",
			"decoder": "meshtastic-eu",
			"type": "meshtastic",
			"data": {
				"from": 3735928559,
				"to": 4294967295,
				"id": 1234567890,
				"channel": 8,
				"hopLimit": 2,
				"hopStart": 3,
				"wantAck": false,
				"portnum": 1,
				"payloadB64": "SGVsbG8gV29ybGQ=",
				"payloadLen": 11,
				"rxRssi": -97,
				"rxSnr": 6.5,
				"rxTime": "2026-05-15T14:23:45.012Z",
				"frequency": 869525000,
				"bw": 250000,
				"sf": 11,
				"cr": 5
			}
		}
	}
}
```

#### decoder:started

```json
{
	"type": "decoder:started",
	"channel": "decoders",
	"data": {
		"id": "dsd-main",
		"pid": 1234
	}
}
```

#### decoder:stopped

```json
{
	"type": "decoder:stopped",
	"channel": "decoders",
	"data": {
		"id": "dsd-main",
		"exitCode": 0
	}
}
```

#### decoder:health

```json
{
	"type": "decoder:health",
	"channel": "health",
	"data": {
		"id": "dsd-main",
		"health": "degraded",
		"previousHealth": "running",
		"reason": "No output for 30 seconds"
	}
}
```

#### source:connected

```json
{
	"type": "source:connected",
	"channel": "sources",
	"data": {
		"id": "sdrpp-main",
		"host": "192.168.1.69",
		"port": 5555
	}
}
```

#### source:disconnected

```json
{
	"type": "source:disconnected",
	"channel": "sources",
	"data": {
		"id": "sdrpp-main",
		"error": "Connection reset by peer"
	}
}
```

#### source:caps-changed

Emitted when source capabilities change dynamically (e.g., sample rate changed via TunerRelay).

```json
{
	"type": "source:caps-changed",
	"channel": "sources",
	"data": {
		"sourceId": "rtl-pi",
		"caps": {
			"kind": "iq",
			"sampleRate": 2400000,
			"format": "U8_IQ",
			"exclusive": false
		}
	}
}
```

#### metrics

Emitted every ~5 seconds.

```json
{
	"type": "metrics",
	"channel": "metrics",
	"data": {
		"timestamp": "2026-01-09T14:23:45.123Z",
		"sources": {
			"sdrpp-main": {
				"bytesReceived": 847000000,
				"dataRate": 192000
			}
		},
		"decoders": {
			"dsd-main": {
				"bytesIn": 423000000,
				"eventsOut": 847
			}
		}
	}
}
```

#### fanout:snapshot

Backpressure status snapshot.

```json
{
	"type": "fanout:snapshot",
	"channel": "fanout",
	"data": {
		"timestamp": "2026-01-09T14:23:45.123Z",
		"totalBytesWritten": 847000000,
		"droppedBytesTotal": 0,
		"backpressureActiveCount": 0,
		"branches": [
			{
				"id": "dsd-main",
				"bufferedBytes": 1024,
				"droppedBytesTotal": 0,
				"backpressure": false
			}
		]
	}
}
```

#### subscribed

Confirmation of subscription.

```json
{
	"type": "subscribed",
	"data": {
		"channels": ["decoders", "sources", "metrics", "health", "fanout"]
	}
}
```

#### error

```json
{
	"type": "error",
	"data": {
		"message": "Invalid channel: foo"
	}
}
```

## Audio Streaming

Decoded audio is available via TCP on port 8080.

### Format

- **Encoding**: S16LE (16-bit signed, little-endian)
- **Sample Rate**: 48000 Hz
- **Channels**: 1 (mono)

### Playback Examples

```bash
# Using sox
nc localhost 8080 | play -t raw -r 48000 -e signed -b 16 -c 1 -

# Using ffplay
nc localhost 8080 | ffplay -f s16le -ar 48000 -ac 1 -nodisp -

# Using VLC
nc localhost 8080 | vlc --demux=rawaud --rawaud-channels=1 --rawaud-samplerate=48000 -

# Record to file
nc localhost 8080 | sox -t raw -r 48000 -e signed -b 16 -c 1 - output.wav
```

## Error Responses

All error responses follow this format:

```json
{
	"error": {
		"code": "DECODER_NOT_FOUND",
		"message": "Decoder 'foo' not found",
		"statusCode": 404
	}
}
```

### Error Codes

| Code                      | HTTP Status | Description                    |
| ------------------------- | ----------- | ------------------------------ |
| `DECODER_NOT_FOUND`       | 404         | Decoder ID doesn't exist       |
| `SOURCE_NOT_FOUND`        | 404         | Source ID doesn't exist        |
| `DECODER_ALREADY_RUNNING` | 409         | Decoder is already running     |
| `DECODER_NOT_RUNNING`     | 409         | Decoder is not running         |
| `INVALID_CONFIG`          | 400         | Invalid configuration provided |
| `SOURCE_CONNECTION_ERROR` | 503         | Cannot connect to source       |
| `INTERNAL_ERROR`          | 500         | Internal server error          |

## Rate Limiting

The API does not currently implement rate limiting. For production deployments, consider placing a reverse proxy (nginx, Caddy) in front of WaveKit.

## CORS

CORS is enabled by default, allowing requests from any origin. Configure via:

```yaml
api:
  cors:
    enabled: true
    origins: ["*"]
```
