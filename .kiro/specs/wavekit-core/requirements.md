# Requirements Document

## Introduction

WaveKit is a TypeScript-based SDR (Software Defined Radio) stream processing framework that connects to SDR sources, fans out audio streams to multiple signal decoders in parallel, and provides a Fastify REST/WebSocket API for control and monitoring. The system runs in Docker with optional SDR++ Server integration and outputs decoded audio over TCP for host-side playback.

## Glossary

- **WaveKit**: The main TypeScript application that orchestrates SDR stream processing
- **Source_Manager**: Component responsible for TCP connections to SDR sources with auto-reconnect
- **Fanout_Manager**: Component that multiplexes audio streams to multiple decoder consumers
- **Decoder_Manager**: Component that handles lifecycle management for decoder processes
- **Decoder**: A signal processing program that decodes audio or IQ streams into structured data
- **Decoder_Registry**: Plugin system for registering and creating decoder instances
- **Format_Converter**: Transform streams for audio format conversion (F32↔S16, resampling)
- **Audio_Output**: TCP server that streams decoded audio to host-side players
- **API_Server**: Fastify-based REST and WebSocket server for control and monitoring
- **SDR_Source**: An SDR data provider (rtl_tcp, SDR++ network sink, or recording file)
- **IQ_Data**: In-phase and Quadrature data from SDR hardware (baseband samples)
- **PCM_Audio**: Pulse Code Modulation audio data (S16LE or FLOAT32LE format)
- **Source_Caps**: Capability declaration for a source (kind, sampleRate, format, exclusive)
- **Decoder_Caps**: Capability declaration for a decoder (input type, output format, exclusivity)
- **Recording_Source**: A source that replays recorded IQ or audio files for testing
- **Network_Producer**: A decoder pattern where the decoder runs as a service exposing network outputs
- **External_SDR_Owner**: A decoder pattern where the decoder manages its own SDR hardware
- **Readsb_Decoder**: Decoder adapter for readsb ADS-B decoder
- **Acarsdec_Decoder**: Decoder adapter for acarsdec ACARS decoder
- **Dumpvdl2_Decoder**: Decoder adapter for dumpvdl2 VDL Mode 2 decoder
- **AISCatcher_Decoder**: Decoder adapter for AIS-catcher maritime decoder
- **Direwolf_Decoder**: Decoder adapter for direwolf APRS decoder
- **AircraftData**: Structured output for ADS-B aircraft position and identification
- **ACARSMessage**: Structured output for ACARS data link messages
- **VDL2Message**: Structured output for VDL Mode 2 data link messages
- **ShipData**: Structured output for AIS vessel position and identification
- **APRSData**: Structured output for APRS amateur radio packets

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

---

## Decoder Expansion Requirements

### Requirement 15: Multi-Source Management

**User Story:** As a system operator, I want to connect multiple SDR sources simultaneously, so that I can run decoders on different frequencies that require dedicated tuners.

#### Acceptance Criteria

1. WHEN multiple source configurations are provided, THE Source_Manager SHALL establish independent TCP connections to each source
2. WHEN a decoder is configured, THE Decoder_Manager SHALL assign it to a specific source by source ID
3. WHEN a source is exclusive, THE Source_Manager SHALL prevent multiple decoders from sharing it
4. WHEN sources are listed, THE Source_Manager SHALL return capabilities (kind, sampleRate, format, exclusive) for each source
5. THE Source_Manager SHALL support source kinds: audio_pcm, iq, recording

### Requirement 16: Source Capabilities Declaration

**User Story:** As a system operator, I want sources to declare their capabilities, so that decoders can be matched to compatible sources.

#### Acceptance Criteria

1. WHEN a source is configured, THE Source_Manager SHALL validate and store its capabilities (kind, sampleRate, format, channels, centerFreq, exclusive)
2. WHEN a decoder requests a source, THE Source_Manager SHALL verify capability compatibility before attachment
3. IF a decoder's required input type does not match the source kind, THEN THE Source_Manager SHALL return a compatibility error

### Requirement 17: Decoder Capabilities Declaration

**User Story:** As a developer, I want decoders to declare their input/output capabilities, so that the system can validate source-decoder compatibility.

#### Acceptance Criteria

1. WHEN a decoder is registered, THE Decoder_Registry SHALL store its capabilities (input type, exclusive requirement, preferred sample rates, output format)
2. WHEN a decoder is created, THE Decoder_Manager SHALL validate its capabilities against the assigned source
3. THE Decoder_Registry SHALL support input types: audio_pcm, iq, external
4. THE Decoder_Registry SHALL support output formats: jsonl, nmea, beast, text

### Requirement 18: Network Producer Decoder Pattern

**User Story:** As a system operator, I want to integrate decoders that run as network services, so that I can use decoders like readsb and AIS-catcher that expose TCP/UDP outputs.

#### Acceptance Criteria

1. WHEN a network producer decoder is started, THE Decoder_Manager SHALL spawn the process and connect to its output port
2. WHEN the decoder produces output on its network port, THE Decoder_Manager SHALL parse it into structured DecoderOutput objects
3. WHEN the network connection is lost, THE Decoder_Manager SHALL attempt reconnection with exponential backoff
4. THE Decoder_Manager SHALL support output protocols: TCP, UDP

### Requirement 19: External SDR Owner Decoder Pattern

**User Story:** As a system operator, I want to integrate decoders that manage their own SDR hardware, so that I can use decoders like acarsdec and dumpvdl2 that require tuner control.

#### Acceptance Criteria

1. WHEN an external SDR decoder is started, THE Decoder_Manager SHALL spawn it with SDR device configuration (serial, frequency, gain)
2. WHEN the decoder is running, THE Decoder_Manager SHALL NOT attempt to pipe audio to it
3. WHEN the decoder produces output, THE Decoder_Manager SHALL parse it into structured DecoderOutput objects
4. THE Decoder_Manager SHALL pass device serial numbers to external decoders for multi-dongle setups

### Requirement 20: Decoder Health Model

**User Story:** As a system operator, I want detailed decoder health status, so that I can identify degraded or faulted decoders quickly.

#### Acceptance Criteria

1. WHEN a decoder is running and producing output, THE Decoder_Manager SHALL report health as "running"
2. WHEN a decoder is running but has not produced output for the configured timeout, THE Decoder_Manager SHALL report health as "degraded"
3. WHEN a decoder has crashed and exceeded restart limits, THE Decoder_Manager SHALL report health as "faulted"
4. WHEN decoder health changes, THE Decoder_Manager SHALL emit a health event with the new status

### Requirement 21: Recording Source for Testing

**User Story:** As a developer, I want to replay recorded IQ/audio files as sources, so that I can run deterministic CI tests without live SDR hardware.

#### Acceptance Criteria

1. WHEN a recording source is configured, THE Source_Manager SHALL read from the specified file path
2. WHEN the recording ends, THE Source_Manager SHALL optionally loop or emit an 'ended' event
3. THE Recording_Source SHALL support formats: raw IQ (u8, s16), audio PCM (s16le, f32le)
4. WHEN playback speed is configured, THE Recording_Source SHALL emit data at the specified rate multiplier

### Requirement 22: Readsb ADS-B Decoder Integration

**User Story:** As a system operator, I want to decode ADS-B aircraft transponder signals, so that I can track aircraft positions in real-time.

#### Acceptance Criteria

1. WHEN started, THE Readsb_Decoder SHALL spawn readsb with the configured device and output options
2. WHEN readsb outputs aircraft data, THE Readsb_Decoder SHALL parse it into structured AircraftData events
3. THE Readsb_Decoder SHALL support output formats: SBS (BaseStation), Beast binary, JSON
4. WHEN configured, THE Readsb_Decoder SHALL expose its network ports for external feeders

### Requirement 23: ACARS Decoder Integration

**User Story:** As a system operator, I want to decode ACARS aircraft data link messages, so that I can monitor aviation communications.

#### Acceptance Criteria

1. WHEN started, THE Acarsdec_Decoder SHALL spawn acarsdec with the configured frequencies and device
2. WHEN acarsdec decodes a message, THE Acarsdec_Decoder SHALL parse it into structured ACARSMessage events
3. THE Acarsdec_Decoder SHALL support multiple simultaneous frequencies
4. THE Acarsdec_Decoder SHALL normalize output to JSON format

### Requirement 24: VDL2 Decoder Integration

**User Story:** As a system operator, I want to decode VDL Mode 2 data link messages, so that I can monitor modern aviation data communications.

#### Acceptance Criteria

1. WHEN started, THE Dumpvdl2_Decoder SHALL spawn dumpvdl2 with the configured frequencies and device
2. WHEN dumpvdl2 decodes a message, THE Dumpvdl2_Decoder SHALL parse it into structured VDL2Message events
3. THE Dumpvdl2_Decoder SHALL support JSON output format
4. THE Dumpvdl2_Decoder SHALL support multiple simultaneous frequencies

### Requirement 25: AIS Maritime Decoder Integration

**User Story:** As a system operator, I want to decode AIS ship transponder signals, so that I can track vessel positions in real-time.

#### Acceptance Criteria

1. WHEN started, THE AISCatcher_Decoder SHALL spawn AIS-catcher with the configured device and output options
2. WHEN AIS-catcher decodes a message, THE AISCatcher_Decoder SHALL parse it into structured ShipData events
3. THE AISCatcher_Decoder SHALL support output formats: NMEA, JSON
4. THE AISCatcher_Decoder SHALL support multiple input sources (RTL-TCP, SpyServer, SoapySDR)

### Requirement 26: APRS Decoder Integration

**User Story:** As a system operator, I want to decode APRS amateur radio packets, so that I can monitor ham radio position and messaging traffic.

#### Acceptance Criteria

1. WHEN started, THE Direwolf_Decoder SHALL spawn direwolf with the configured audio input and KISS output
2. WHEN direwolf decodes a packet, THE Direwolf_Decoder SHALL parse it into structured APRSData events
3. THE Direwolf_Decoder SHALL support KISS TCP output for packet access
4. THE Direwolf_Decoder SHALL support audio input from PCM streams

### Requirement 27: Decoder Version Pinning

**User Story:** As a system operator, I want decoder versions to be pinned and tracked, so that I can maintain security and reproducibility.

#### Acceptance Criteria

1. WHEN a decoder is configured, THE Decoder_Manager SHALL validate the installed version against the pinned version
2. WHEN a version mismatch is detected, THE Decoder_Manager SHALL log a warning with upgrade instructions
3. THE Configuration SHALL support specifying minimum and maximum versions per decoder type
4. WHEN security advisories affect a decoder, THE Documentation SHALL include mitigation guidance
