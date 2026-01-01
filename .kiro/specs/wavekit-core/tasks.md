# Implementation Plan: WaveKit Core

## Overview

This implementation plan follows a bottom-up approach, starting with utilities and core infrastructure, then building the decoder system, API layer, and finally integration. Each task builds on previous work, ensuring no orphaned code.

## Tasks

- [x] 1. Project Setup and Dependencies
  - Update package.json with all required dependencies (fastify, pino, zod, yaml, vitest, fast-check)
  - Configure TypeScript for ESM with strict mode
  - Set up Vitest configuration
  - Create directory structure matching the design
  - _Requirements: 12.1, 13.1_

- [ ] 2. Implement Utility Layer
  - [x] 2.1 Implement custom error classes
    - Create WaveKitError base class and all derived error classes
    - _Requirements: 1.6, 4.2, 5.3, 12.4_
  - [x] 2.2 Implement Logger utility
    - Create Pino-based logger with component child loggers
    - Support configurable log levels and file output
    - _Requirements: 13.1, 13.2, 13.3, 13.4_
  - [x] 2.3 Write property test for log entry structure
    - **Property 23: Log Entry Structure**
    - **Validates: Requirements 13.3**
  - [x] 2.4 Implement Configuration loader
    - Create Zod schemas for all config sections
    - Implement YAML loading with environment variable override
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_
  - [x] 2.5 Write property tests for configuration
    - **Property 21: Config Environment Override**
    - **Property 22: Config Validation Errors**
    - **Validates: Requirements 12.2, 12.3, 12.4**
  - [x] 2.6 Implement Graceful Shutdown handler
    - Create shutdown handler registry with timeout support
    - Install SIGTERM/SIGINT signal handlers
    - _Requirements: 14.1, 14.6_

- [x] 3. Checkpoint - Utility Layer
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement Core Stream Components
  - [x] 4.1 Implement Format Converter transforms
    - Create F32→S16 and S16→F32 transform streams
    - Create resample transform stream
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [x] 4.2 Write property tests for format conversion
    - **Property 7: Format Conversion Round-Trip**
    - **Property 8: Resample Length Ratio**
    - **Validates: Requirements 3.1, 3.2, 3.3**
  - [x] 4.3 Implement Fanout Manager
    - Create branch management with independent buffering
    - Implement backpressure detection and event emission
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
  - [x] 4.4 Write property tests for Fanout Manager
    - **Property 4: Fanout Data Distribution**
    - **Property 5: Branch Independence**
    - **Property 6: Backpressure Non-Blocking**
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.5**
  - [x] 4.5 Implement Source Manager
    - Create TCP client with auto-reconnect and exponential backoff
    - Implement status tracking and metrics emission
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_
  - [x] 4.6 Write property tests for Source Manager
    - **Property 1: Exponential Backoff Correctness**
    - **Property 2: Source Status Completeness**
    - **Property 3: Connection Error Resilience**
    - **Validates: Requirements 1.2, 1.6, 1.7**
  - [x] 4.7 Implement Audio Output TCP server
    - Create TCP server for streaming audio to host players
    - Implement multi-client fanout
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
  - [x] 4.8 Write property test for Audio Output
    - **Property 20: Audio Output Multi-Client Distribution**
    - **Validates: Requirements 11.2, 11.3**

- [x] 5. Checkpoint - Core Components
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement Decoder System
  - [x] 6.1 Implement Decoder types and interfaces
    - Create DecoderConfig, DecoderOutput, DecoderStatus types
    - Define Decoder interface
    - _Requirements: 4.4, 4.5, 4.6_
  - [x] 6.2 Implement Decoder Registry
    - Create factory registration and decoder creation
    - Implement type listing
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [x] 6.3 Write property test for Decoder Registry
    - **Property 9: Decoder Registry Consistency**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
  - [x] 6.4 Implement Base Decoder abstract class
    - Create process spawning with stdio piping
    - Implement graceful stop with SIGTERM/SIGKILL
    - Create output stream in object mode
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.6_
  - [x] 6.5 Write property test for Decoder Status
    - **Property 10: Decoder Status Completeness**
    - **Validates: Requirements 4.5**
  - [x] 6.6 Implement DSD-FME Decoder
    - Extend BaseDecoder with dsd-fme specific args
    - Implement output parsing for sync, call, error events
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [x] 6.7 Write property tests for DSD-FME parsing
    - **Property 11: DSD Output Parsing**
    - **Property 12: DSD Mode Support**
    - **Validates: Requirements 6.2, 6.3, 6.4, 6.5**
  - [x] 6.8 Implement Multimon-ng Decoder
    - Extend BaseDecoder with multimon-ng specific args
    - Implement output parsing for POCSAG, FLEX, DTMF
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - [ ] 6.9 Write property tests for Multimon-ng parsing
    - **Property 13: Multimon Output Parsing**
    - **Property 14: Multimon Mode Support**
    - **Validates: Requirements 7.2, 7.3**
  - [x] 6.10 Implement RTL_433 Decoder
    - Extend BaseDecoder with rtl_433 specific args
    - Implement JSON output parsing
    - _Requirements: 8.1, 8.2, 8.3_
  - [x] 6.11 Write property test for RTL_433 parsing
    - **Property 15: RTL433 JSON Parsing**
    - **Validates: Requirements 8.2**
  - [x] 6.12 Implement Decoder Manager
    - Create decoder lifecycle orchestration
    - Implement auto-restart with exponential backoff
    - Wire decoders to fanout branches
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 7. Checkpoint - Decoder System
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement API Layer
  - [-] 8.1 Implement Fastify server setup
    - Create server with plugins (websocket, swagger)
    - Configure CORS and error handling
    - _Requirements: 9.1_
  - [ ] 8.2 Implement health and status routes
    - GET /health endpoint
    - GET /api/status endpoint with full system status
    - _Requirements: 9.1, 9.2_
  - [ ] 8.3 Write property test for status response
    - **Property 16: API Status Response Completeness**
    - **Validates: Requirements 9.2**
  - [ ] 8.4 Implement source routes
    - GET /api/sources - list sources
    - POST /api/sources - add source
    - DELETE /api/sources/:id - remove source
    - _Requirements: 9.3, 9.4, 9.5_
  - [ ] 8.5 Write property test for source CRUD
    - **Property 17: Source CRUD Consistency**
    - **Validates: Requirements 9.3, 9.4, 9.5**
  - [ ] 8.6 Implement decoder routes
    - GET /api/decoders - list decoders
    - GET /api/decoders/:id - get decoder status
    - POST /api/decoders/:id/start - start decoder
    - POST /api/decoders/:id/stop - stop decoder
    - POST /api/decoders/:id/restart - restart decoder
    - PATCH /api/decoders/:id - update config
    - _Requirements: 9.6, 9.7, 9.8, 9.9_
  - [ ] 8.7 Write property test for decoder API
    - **Property 18: Decoder API State Consistency**
    - **Validates: Requirements 9.6, 9.7, 9.8**
  - [ ] 8.8 Implement WebSocket event broadcasting
    - Create subscription management
    - Broadcast decoder output, source events, metrics
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_
  - [ ] 8.9 Write property test for WebSocket filtering
    - **Property 19: WebSocket Channel Filtering**
    - **Validates: Requirements 10.2, 10.3, 10.4**

- [ ] 9. Checkpoint - API Layer
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Application Bootstrap and Integration
  - [ ] 10.1 Implement main application bootstrap
    - Load configuration
    - Initialize all components in correct order
    - Register shutdown handlers
    - Start API server
    - _Requirements: 12.1, 14.1_
  - [ ] 10.2 Wire components together
    - Connect Source Manager → Fanout Manager → Decoders
    - Connect Decoder outputs → WebSocket broadcaster
    - Connect Audio Output to decoder audio streams
    - _Requirements: 1.1, 2.1, 4.1, 11.1_
  - [ ] 10.3 Write property test for graceful shutdown
    - **Property 24: Graceful Shutdown Completeness**
    - **Validates: Requirements 14.2, 14.3, 14.4, 14.5**
  - [ ] 10.4 Create default configuration file
    - Create config/default.yaml with documented options
    - _Requirements: 12.1, 12.5_

- [ ] 11. Final Checkpoint
  - Ensure all tests pass, ask the user if questions arise.
  - Run full test suite with coverage report
  - Verify all requirements are covered

---

## Phase 2: Decoder Expansion

### Overview

This phase implements the decoder expansion roadmap, adding multi-source support, new decoder integration patterns, and aviation/maritime/amateur radio decoders.

- [ ] 12. Multi-Source Foundation
  - [ ] 12.1 Extend Source Manager for multi-source support
    - Add SourceCaps interface and capability validation
    - Support multiple simultaneous source connections
    - Implement source-decoder assignment tracking
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 16.1, 16.2, 16.3_
  - [ ] 12.2 Write property tests for multi-source
    - **Property 25: Source Capability Compatibility**
    - **Property 26: Multi-Source Independence**
    - **Property 27: Decoder-Source Assignment Consistency**
    - **Property 28: Exclusive Source Enforcement**
    - **Validates: Requirements 15.1, 15.2, 15.3, 16.2, 17.2**
  - [ ] 12.3 Implement Recording Source
    - Create file-based source for IQ/audio replay
    - Support loop and playback speed options
    - _Requirements: 21.1, 21.2, 21.3, 21.4_
  - [ ] 12.4 Write property test for Recording Source
    - **Property 29: Recording Source Determinism**
    - **Validates: Requirements 21.1, 21.3**
  - [ ] 12.5 Update Configuration schemas
    - Add SourceCaps and DecoderCaps schemas
    - Add health monitoring configuration
    - Update decoder config for new patterns
    - _Requirements: 15.4, 17.1, 17.2, 17.3, 17.4_

- [ ] 13. Checkpoint - Multi-Source Foundation
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Decoder Integration Patterns
  - [ ] 14.1 Extend Decoder types with capabilities
    - Add DecoderCaps interface
    - Add DecoderHealth type and health tracking
    - Update DecoderStatus with health and version
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 20.1, 20.2, 20.3, 20.4_
  - [ ] 14.2 Implement Network Producer Decoder base class
    - Create abstract class for decoders with network outputs
    - Implement TCP/UDP client with reconnection
    - _Requirements: 18.1, 18.2, 18.3, 18.4_
  - [ ] 14.3 Write property test for Network Producer reconnection
    - **Property 31: Network Producer Reconnection**
    - **Validates: Requirements 18.3**
  - [ ] 14.4 Implement External SDR Decoder base class
    - Create abstract class for decoders managing own SDR
    - Pass device serial and frequencies to process
    - _Requirements: 19.1, 19.2, 19.3, 19.4_
  - [ ] 14.5 Write property test for External SDR Decoder
    - **Property 32: External SDR Decoder Device Isolation**
    - **Validates: Requirements 19.1, 19.2, 19.4**
  - [ ] 14.6 Implement Decoder Health Model
    - Add health state tracking (running/degraded/faulted)
    - Implement periodic health checks in Decoder Manager
    - Emit health change events
    - _Requirements: 20.1, 20.2, 20.3, 20.4_
  - [ ] 14.7 Write property test for Health State Transitions
    - **Property 30: Health State Transitions**
    - **Validates: Requirements 20.1, 20.2, 20.3, 20.4**
  - [ ] 14.8 Update Decoder Registry with capabilities
    - Store DecoderCaps with factory registration
    - Add capability query methods
    - _Requirements: 17.1, 17.2_

- [ ] 15. Checkpoint - Decoder Integration Patterns
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Aviation Decoders (Phase 1 - ADS-B)
  - [ ] 16.1 Implement Readsb ADS-B Decoder
    - Extend NetworkProducerDecoder for readsb
    - Support SBS, Beast, and JSON output formats
    - Parse output into AircraftData events
    - _Requirements: 22.1, 22.2, 22.3, 22.4_
  - [ ] 16.2 Write property test for Readsb parsing
    - **Property 33: ADS-B Output Parsing**
    - **Validates: Requirements 22.2**
  - [ ] 16.3 Create ADS-B test fixtures
    - Add sample SBS, Beast, and JSON output files
    - Create recording source files for CI testing

- [ ] 17. Checkpoint - ADS-B Decoder
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 18. Aviation Decoders (Phase 2 - Data Links)
  - [ ] 18.1 Implement ACARS Decoder (acarsdec)
    - Extend ExternalSdrDecoder for acarsdec
    - Support multiple frequencies
    - Parse JSON output into ACARSMessage events
    - _Requirements: 23.1, 23.2, 23.3, 23.4_
  - [ ] 18.2 Write property test for ACARS parsing
    - **Property 34: ACARS Output Parsing**
    - **Validates: Requirements 23.2**
  - [ ] 18.3 Implement VDL2 Decoder (dumpvdl2)
    - Extend ExternalSdrDecoder for dumpvdl2
    - Support multiple frequencies
    - Parse JSON output into VDL2Message events
    - _Requirements: 24.1, 24.2, 24.3, 24.4_
  - [ ] 18.4 Write property test for VDL2 parsing
    - **Property 35: VDL2 Output Parsing**
    - **Validates: Requirements 24.2**
  - [ ] 18.5 Create Aviation Data Link test fixtures
    - Add sample acarsdec and dumpvdl2 output files
    - Create recording source files for CI testing

- [ ] 19. Checkpoint - Aviation Data Links
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 20. Maritime Decoders (AIS)
  - [ ] 20.1 Implement AIS-catcher Decoder
    - Extend NetworkProducerDecoder for AIS-catcher
    - Support NMEA and JSON output formats
    - Parse output into ShipData events
    - _Requirements: 25.1, 25.2, 25.3, 25.4_
  - [ ] 20.2 Write property test for AIS parsing
    - **Property 36: AIS Output Parsing**
    - **Validates: Requirements 25.2**
  - [ ] 20.3 Create AIS test fixtures
    - Add sample NMEA and JSON output files
    - Create recording source files for CI testing

- [ ] 21. Checkpoint - Maritime Decoders
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 22. Amateur Radio Decoders (APRS)
  - [ ] 22.1 Implement Direwolf APRS Decoder
    - Extend NetworkProducerDecoder for direwolf
    - Connect to KISS TCP port for packet access
    - Parse KISS frames into APRSData events
    - _Requirements: 26.1, 26.2, 26.3, 26.4_
  - [ ] 22.2 Write property test for APRS parsing
    - **Property 37: APRS Output Parsing**
    - **Validates: Requirements 26.2**
  - [ ] 22.3 Create APRS test fixtures
    - Add sample KISS frame data
    - Create recording source files for CI testing

- [ ] 23. Checkpoint - Amateur Radio Decoders
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 24. Decoder Version Management
  - [ ] 24.1 Implement version detection and validation
    - Detect installed decoder versions at startup
    - Validate against configured min/max versions
    - Log warnings for version mismatches
    - _Requirements: 27.1, 27.2, 27.3_
  - [ ] 24.2 Update documentation with security guidance
    - Document version pinning best practices
    - Add security advisory tracking process
    - _Requirements: 27.4_

- [ ] 25. API Updates for Decoder Expansion
  - [ ] 25.1 Update source routes for multi-source
    - Add capability information to source responses
    - Support source-decoder assignment in API
  - [ ] 25.2 Update decoder routes for new patterns
    - Add health status to decoder responses
    - Support new decoder types in API
  - [ ] 25.3 Add decoder health WebSocket events
    - Broadcast health state changes
    - Add 'health' channel to WebSocket subscriptions

- [ ] 26. Final Checkpoint - Decoder Expansion
  - Ensure all tests pass, ask the user if questions arise.
  - Run full test suite with coverage report
  - Verify all new requirements are covered
  - Update default configuration with example multi-source setup

## Notes

- All tasks including property tests are required for comprehensive coverage
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- The implementation follows the project structure defined in the design document

### Decoder Expansion Notes

- Phase 2 tasks (12-26) implement the decoder expansion roadmap from docs/DECODER-EXPANSION.md
- Multi-source foundation (tasks 12-13) is a prerequisite for all new decoders
- Aviation decoders use the "external SDR" and "network producer" patterns
- Maritime and amateur radio decoders use the "network producer" pattern
- Recording sources enable deterministic CI testing without live SDR hardware
- Health model provides operational visibility into decoder state
- Version pinning addresses security concerns (e.g., Direwolf CVE-2025-34458)
