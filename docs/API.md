# WaveKit API Reference

WaveKit exposes a REST API and WebSocket endpoint for control and real-time monitoring.

## Base URL

- **REST API**: `http://localhost:9000`
- **WebSocket**: `ws://localhost:9000/ws`
- **Audio Stream**: `tcp://localhost:8080`

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
			channels: ["decoders", "sources", "metrics", "health", "fanout"],
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
	"channels": ["decoders", "sources", "metrics", "health", "fanout"]
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
