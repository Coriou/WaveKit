# Requirements Document

## Introduction

WaveKit is a TypeScript-based SDR (Software Defined Radio) stream processing framework that connects to SDR sources, fans out audio streams to multiple signal decoders in parallel, and provides a Fastify REST/WebSocket API for control and monitoring. The system runs in Docker with optional SDR++ Server integration and outputs decoded audio over TCP for host-side playback.

## Glossary

- **WaveKit**: The main TypeScript application that orchestrates SDR stream processing
- **Source_Manager**: Component responsible for TCP connections to SDR sources with auto-reconnect
- **Fanout_Manager**: Component that multiplexes audio streams to multiple decoder consumers
- **Decoder_Manager**: Component that handles lifecycle management for decoder processes
- **Decoder**: A signal processing program (dsd-fme, multimon-ng, rtl_433) that decodes audio streams
- **Decoder_Registry**: Plugin system for registering and creating decoder instances
- **Format_Converter**: Transform streams for audio format conversion (F32↔S16, resampling)
- **Audio_Output**: TCP server that streams decoded audio to host-side players
- **API_Server**: Fastify-based REST and WebSocket server for control and monitoring
- **SDR_Source**: An SDR data provider (rtl_tcp or SDR++ network sink)
- **IQ_Data**: In-phase and Quadrature data from SDR hardware
- **PCM_Audio**: Pulse Code Modulation audio data (S16LE or FLOAT32LE format)

## Requirements

### Requirement 1: SDR Source Connection Management

**User Story:** As a system operator, I want to connect to SDR sources over TCP, so that I can receive audio streams for processing.

#### Acceptance Criteria

1. WHEN a source configuration is provided, THE Source_Manager SHALL establish a TCP connection to the specified host and port
2. WHEN a connection fails, THE Source_Manager SHALL retry with exponential backoff (2s, 4s, 8s, max 30s)
3. WHEN a connection is established, THE Source_Manager SHALL emit a 'connected' event with the source ID
4. WHEN a connection is lost, THE Source_Manager SHALL emit a 'disconnected' event and begin reconnection attempts
5. WHEN data is received, THE Source_Manager SHALL emit data rate metrics every 5 seconds
6. IF connection errors occur (ECONNREFUSED, ETIMEDOUT, ECONNRESET), THEN THE Source_Manager SHALL handle them gracefully without crashing
7. WHEN requested, THE Source_Manager SHALL return status information including connection state, bytes received, and data rate

### Requirement 2: Audio Stream Fanout

**User Story:** As a system operator, I want to distribute a single audio stream to multiple decoders, so that I can process signals with different decoders simultaneously.

#### Acceptance Criteria

1. WHEN a source stream is attached, THE Fanout_Manager SHALL accept it as the input source
2. WHEN a branch is added, THE Fanout_Manager SHALL create an independent buffered stream for that consumer
3. WHEN data arrives from the source, THE Fanout_Manager SHALL copy it to all active branches
4. WHEN a branch buffer fills (exceeds highWaterMark), THE Fanout_Manager SHALL emit a 'backpressure' event without blocking the source
5. WHEN a branch is removed, THE Fanout_Manager SHALL clean up its resources and stop forwarding data to it
6. THE Fanout_Manager SHALL prioritize real-time audio flow over buffering (prefer dropping data over blocking)

### Requirement 3: Audio Format Conversion

**User Story:** As a system operator, I want to convert between audio formats, so that decoders receive data in their required format.

#### Acceptance Criteria

1. WHEN 32-bit float audio is provided, THE Format_Converter SHALL convert it to 16-bit signed integer format
2. WHEN 16-bit signed integer audio is provided, THE Format_Converter SHALL convert it to 32-bit float format
3. WHEN resampling is requested, THE Format_Converter SHALL convert audio from the source sample rate to the target sample rate
4. THE Format_Converter SHALL implement conversions as Node.js Transform streams for pipeline compatibility

### Requirement 4: Decoder Lifecycle Management

**User Story:** As a system operator, I want to manage decoder processes, so that I can start, stop, and monitor signal decoders.

#### Acceptance Criteria

1. WHEN a decoder is started, THE Decoder_Manager SHALL spawn the decoder process with appropriate arguments
2. WHEN a decoder process exits unexpectedly, THE Decoder_Manager SHALL restart it with exponential backoff
3. WHEN a decoder is stopped, THE Decoder_Manager SHALL send SIGTERM and wait, then SIGKILL if needed
4. WHEN a decoder produces output, THE Decoder_Manager SHALL parse it into structured DecoderOutput objects
5. WHEN requested, THE Decoder_Manager SHALL return status for all managed decoders including PID, uptime, and statistics
6. THE Decoder_Manager SHALL emit events for decoder output, errors, and exit conditions

### Requirement 5: Decoder Plugin System

**User Story:** As a developer, I want to register new decoder types, so that the system can be extended with additional signal decoders.

#### Acceptance Criteria

1. WHEN a decoder type is registered, THE Decoder_Registry SHALL store the factory function for that type
2. WHEN a decoder is requested by type, THE Decoder_Registry SHALL create an instance using the registered factory
3. WHEN an unregistered decoder type is requested, THE Decoder_Registry SHALL return an error
4. THE Decoder_Registry SHALL provide a list of all registered decoder types

### Requirement 6: DSD-FME Decoder Integration

**User Story:** As a system operator, I want to decode digital voice signals (DMR, P25, YSF, D-Star, NXDN, ProVoice), so that I can monitor digital radio communications.

#### Acceptance Criteria

1. WHEN started, THE DSD_Decoder SHALL spawn dsd-fme with the configured mode and options
2. WHEN dsd-fme outputs sync information, THE DSD_Decoder SHALL parse it into structured sync events
3. WHEN dsd-fme decodes a call, THE DSD_Decoder SHALL emit call events with talkgroup, source, and duration
4. WHEN dsd-fme encounters errors, THE DSD_Decoder SHALL emit error events with the error message
5. THE DSD_Decoder SHALL support modes: auto, dmr, p25, ysf, dstar, nxdn, provoice

### Requirement 7: Multimon-ng Decoder Integration

**User Story:** As a system operator, I want to decode pager and data protocols, so that I can monitor POCSAG, FLEX, and other signals.

#### Acceptance Criteria

1. WHEN started, THE Multimon_Decoder SHALL spawn multimon-ng with the configured modes
2. WHEN multimon-ng decodes a message, THE Multimon_Decoder SHALL parse it into structured message events
3. THE Multimon_Decoder SHALL support modes: POCSAG512, POCSAG1200, POCSAG2400, FLEX, EAS, AFSK1200, FSK9600, DTMF
4. WHEN audio filters are configured, THE Multimon_Decoder SHALL apply highpass, lowpass, and gain settings

### Requirement 8: RTL_433 Decoder Integration

**User Story:** As a system operator, I want to decode ISM band signals, so that I can monitor weather sensors and other devices.

#### Acceptance Criteria

1. WHEN started, THE RTL433_Decoder SHALL spawn rtl_433 with the configured options
2. WHEN rtl_433 decodes a signal, THE RTL433_Decoder SHALL parse it into structured signal events
3. THE RTL433_Decoder SHALL support protocol filtering and analyze mode

### Requirement 9: REST API for System Control

**User Story:** As a system operator, I want to control the system via REST API, so that I can manage sources and decoders programmatically.

#### Acceptance Criteria

1. WHEN GET /health is called, THE API_Server SHALL return system health status
2. WHEN GET /api/status is called, THE API_Server SHALL return full system status including sources, decoders, and audio output
3. WHEN GET /api/sources is called, THE API_Server SHALL return all configured sources
4. WHEN POST /api/sources is called with valid config, THE API_Server SHALL add and connect a new source
5. WHEN DELETE /api/sources/:id is called, THE API_Server SHALL disconnect and remove the source
6. WHEN GET /api/decoders is called, THE API_Server SHALL return all decoder statuses
7. WHEN POST /api/decoders/:id/start is called, THE API_Server SHALL start the specified decoder
8. WHEN POST /api/decoders/:id/stop is called, THE API_Server SHALL stop the specified decoder
9. WHEN PATCH /api/decoders/:id is called, THE API_Server SHALL update the decoder configuration

### Requirement 10: WebSocket Real-time Events

**User Story:** As a system operator, I want to receive real-time events, so that I can monitor decoder output and system status live.

#### Acceptance Criteria

1. WHEN a client connects to /ws, THE API_Server SHALL accept the WebSocket connection
2. WHEN a client subscribes to channels, THE API_Server SHALL send events for those channels only
3. WHEN a decoder produces output, THE API_Server SHALL broadcast it to subscribed clients
4. WHEN a source connects or disconnects, THE API_Server SHALL broadcast the event to subscribed clients
5. THE API_Server SHALL support channels: decoders, metrics, sources

### Requirement 11: Audio Output over TCP

**User Story:** As a system operator, I want decoded audio streamed over TCP, so that I can play it on the host machine.

#### Acceptance Criteria

1. WHEN the audio output server starts, THE Audio_Output SHALL listen on the configured TCP port
2. WHEN a client connects, THE Audio_Output SHALL stream decoded audio in the configured format
3. WHEN multiple clients connect, THE Audio_Output SHALL stream to all connected clients
4. WHEN a client disconnects, THE Audio_Output SHALL clean up resources for that client
5. THE Audio_Output SHALL support S16LE format at 48kHz sample rate

### Requirement 12: Configuration Management

**User Story:** As a system operator, I want to configure the system via YAML files and environment variables, so that I can customize behavior for different deployments.

#### Acceptance Criteria

1. WHEN the application starts, THE Config_Loader SHALL load configuration from the default YAML file
2. WHEN environment variables are set, THE Config_Loader SHALL override corresponding config values
3. WHEN configuration is loaded, THE Config_Loader SHALL validate it against the Zod schema
4. IF configuration is invalid, THEN THE Config_Loader SHALL return descriptive validation errors
5. THE Config_Loader SHALL support configuration for: sources, decoders, audio output, API server, and logging

### Requirement 13: Structured Logging

**User Story:** As a system operator, I want structured JSON logs, so that I can monitor and debug the system effectively.

#### Acceptance Criteria

1. THE Logger SHALL output logs in JSON format using Pino
2. THE Logger SHALL support log levels: trace, debug, info, warn, error
3. THE Logger SHALL include timestamps, log level, and component name in each log entry
4. WHEN configured, THE Logger SHALL write logs to the specified directory

### Requirement 14: Graceful Shutdown

**User Story:** As a system operator, I want the system to shut down gracefully, so that resources are cleaned up properly.

#### Acceptance Criteria

1. WHEN SIGTERM is received, THE Application SHALL begin graceful shutdown
2. WHEN shutting down, THE Application SHALL stop accepting new connections
3. WHEN shutting down, THE Application SHALL stop all decoders gracefully
4. WHEN shutting down, THE Application SHALL close all source connections
5. WHEN shutting down, THE Application SHALL destroy all streams to prevent memory leaks
6. IF shutdown takes longer than 10 seconds, THEN THE Application SHALL force exit
