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
  - [ ] 2.6 Implement Graceful Shutdown handler
    - Create shutdown handler registry with timeout support
    - Install SIGTERM/SIGINT signal handlers
    - _Requirements: 14.1, 14.6_

- [ ] 3. Checkpoint - Utility Layer
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement Core Stream Components
  - [ ] 4.1 Implement Format Converter transforms
    - Create F32→S16 and S16→F32 transform streams
    - Create resample transform stream
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [ ] 4.2 Write property tests for format conversion
    - **Property 7: Format Conversion Round-Trip**
    - **Property 8: Resample Length Ratio**
    - **Validates: Requirements 3.1, 3.2, 3.3**
  - [ ] 4.3 Implement Fanout Manager
    - Create branch management with independent buffering
    - Implement backpressure detection and event emission
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
  - [ ] 4.4 Write property tests for Fanout Manager
    - **Property 4: Fanout Data Distribution**
    - **Property 5: Branch Independence**
    - **Property 6: Backpressure Non-Blocking**
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.5**
  - [ ] 4.5 Implement Source Manager
    - Create TCP client with auto-reconnect and exponential backoff
    - Implement status tracking and metrics emission
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_
  - [ ] 4.6 Write property tests for Source Manager
    - **Property 1: Exponential Backoff Correctness**
    - **Property 2: Source Status Completeness**
    - **Property 3: Connection Error Resilience**
    - **Validates: Requirements 1.2, 1.6, 1.7**
  - [ ] 4.7 Implement Audio Output TCP server
    - Create TCP server for streaming audio to host players
    - Implement multi-client fanout
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
  - [ ] 4.8 Write property test for Audio Output
    - **Property 20: Audio Output Multi-Client Distribution**
    - **Validates: Requirements 11.2, 11.3**

- [ ] 5. Checkpoint - Core Components
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement Decoder System
  - [ ] 6.1 Implement Decoder types and interfaces
    - Create DecoderConfig, DecoderOutput, DecoderStatus types
    - Define Decoder interface
    - _Requirements: 4.4, 4.5, 4.6_
  - [ ] 6.2 Implement Decoder Registry
    - Create factory registration and decoder creation
    - Implement type listing
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [ ] 6.3 Write property test for Decoder Registry
    - **Property 9: Decoder Registry Consistency**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
  - [ ] 6.4 Implement Base Decoder abstract class
    - Create process spawning with stdio piping
    - Implement graceful stop with SIGTERM/SIGKILL
    - Create output stream in object mode
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.6_
  - [ ] 6.5 Write property test for Decoder Status
    - **Property 10: Decoder Status Completeness**
    - **Validates: Requirements 4.5**
  - [ ] 6.6 Implement DSD-FME Decoder
    - Extend BaseDecoder with dsd-fme specific args
    - Implement output parsing for sync, call, error events
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [ ] 6.7 Write property tests for DSD-FME parsing
    - **Property 11: DSD Output Parsing**
    - **Property 12: DSD Mode Support**
    - **Validates: Requirements 6.2, 6.3, 6.4, 6.5**
  - [ ] 6.8 Implement Multimon-ng Decoder
    - Extend BaseDecoder with multimon-ng specific args
    - Implement output parsing for POCSAG, FLEX, DTMF
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - [ ] 6.9 Write property tests for Multimon-ng parsing
    - **Property 13: Multimon Output Parsing**
    - **Property 14: Multimon Mode Support**
    - **Validates: Requirements 7.2, 7.3**
  - [ ] 6.10 Implement RTL_433 Decoder
    - Extend BaseDecoder with rtl_433 specific args
    - Implement JSON output parsing
    - _Requirements: 8.1, 8.2, 8.3_
  - [ ] 6.11 Write property test for RTL_433 parsing
    - **Property 15: RTL433 JSON Parsing**
    - **Validates: Requirements 8.2**
  - [ ] 6.12 Implement Decoder Manager
    - Create decoder lifecycle orchestration
    - Implement auto-restart with exponential backoff
    - Wire decoders to fanout branches
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [ ] 7. Checkpoint - Decoder System
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement API Layer
  - [ ] 8.1 Implement Fastify server setup
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

## Notes

- All tasks including property tests are required for comprehensive coverage
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- The implementation follows the project structure defined in the design document
