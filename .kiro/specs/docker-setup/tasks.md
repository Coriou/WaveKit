# Implementation Plan: Docker Setup

## Overview

This implementation plan covers solidifying the WaveKit Docker setup to include all 8 decoders, improve process management, add comprehensive health checking, and ensure the container "just works" with minimal configuration.

## Tasks

- [x] 1. Update Dockerfile with all decoder build stages
  - [x] 1.1 Add acarsdec build stage
    - Clone github.com/TLeconte/acarsdec
    - Build with cmake, install to /usr/local/bin
    - Dependencies: librtlsdr-dev, libsndfile-dev
    - _Requirements: 1.1, 1.5_

  - [x] 1.2 Add AIS-catcher build stage
    - Clone github.com/jvde-github/AIS-catcher
    - Build with cmake, install to /usr/local/bin
    - Dependencies: librtlsdr-dev, libairspy-dev, libairspyhf-dev, libhackrf-dev, libsoapysdr-dev, zlib1g-dev
    - _Requirements: 1.1, 1.5_

  - [x] 1.3 Add direwolf build stage
    - Clone github.com/wb2osz/direwolf
    - Build with cmake, install to /usr/local/bin
    - Dependencies: libasound2-dev, libgps-dev, libhamlib-dev
    - _Requirements: 1.1, 1.5_

  - [x] 1.4 Add dumpvdl2 build stage
    - Clone github.com/szpajder/dumpvdl2
    - Build with cmake, install to /usr/local/bin
    - Dependencies: librtlsdr-dev, libglib2.0-dev, libsqlite3-dev, libzmq3-dev
    - _Requirements: 1.1, 1.5_

  - [x] 1.5 Add readsb build stage
    - Clone github.com/wiedehopf/readsb
    - Build with make, install to /usr/local/bin
    - Dependencies: librtlsdr-dev, libncurses-dev, zlib1g-dev
    - _Requirements: 1.1, 1.5_

  - [x] 1.6 Update base-deps stage with all required build dependencies
    - Add libitpp-dev for dsd-fme
    - Add libgps-dev, libhamlib-dev for direwolf
    - Add libglib2.0-dev, libsqlite3-dev, libzmq3-dev for dumpvdl2
    - Add libncurses-dev for readsb
    - _Requirements: 1.5_

  - [x] 1.7 Update runtime-base stage with all required runtime libraries
    - Add libitpp8 for dsd-fme
    - Add libgps28, libhamlib4 for direwolf
    - Add libglib2.0-0, libsqlite3-0, libzmq5 for dumpvdl2
    - Add libncurses6 for readsb
    - _Requirements: 1.5_

  - [x] 1.8 Update final stage to copy all decoder binaries
    - Copy acarsdec, AIS-catcher, direwolf, dumpvdl2, readsb from build stages
    - Add verification commands for all 8 decoders
    - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Checkpoint - Verify all decoders build successfully
  - Build the full image and verify all 8 decoder binaries are present
  - Run `docker run wavekit:latest which dsd-fme multimon-ng rtl_433 acarsdec AIS-catcher direwolf dumpvdl2 readsb`
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Improve s6-overlay service definitions
  - [x] 3.1 Add finish scripts for graceful cleanup
    - Create finish script for sdrpp-server service
    - Create finish script for wavekit-api service
    - Ensure proper signal handling and resource cleanup
    - _Requirements: 3.3, 3.6_

  - [x] 3.2 Add services bundle for dependency management
    - Create /etc/s6-overlay/s6-rc.d/services bundle
    - Define contents.d with all service dependencies
    - _Requirements: 3.1_

  - [x] 3.3 Update wavekit-api run script with environment propagation
    - Use with-contenv for environment variable access
    - Add proper logging redirection
    - _Requirements: 3.4_

- [x] 4. Implement comprehensive health check system
  - [x] 4.1 Create health check utility module
    - Create src/utils/health-check.ts
    - Implement checkApiHealth() function
    - Implement checkDecoderHealth() function for each decoder type
    - Implement checkSourceHealth() function
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 4.2 Add /health endpoint to API
    - Return quick liveness status (200 OK or 503)
    - _Requirements: 4.1, 4.5_

  - [x] 4.3 Add /health/ready endpoint
    - Check if all configured services are ready
    - Return 200 when ready to accept traffic
    - _Requirements: 4.5_

  - [x] 4.4 Add /api/status endpoint with detailed health
    - Return full HealthStatus JSON with all component states
    - Include healthy/degraded/unhealthy status
    - _Requirements: 4.5, 10.4_

  - [x] 4.5 Update docker/scripts/healthcheck.sh
    - Add timeout handling (10 second max)
    - Check all configured decoders
    - Return proper exit codes
    - _Requirements: 4.4, 4.6_

  - [x] 4.6 Write property test for health check exit codes
    - **Property 8: Health Check Exit Code Matches State**
    - **Validates: Requirements 4.4**

- [x] 5. Implement configuration system improvements
  - [x] 5.1 Create config loader with environment variable support
    - Parse WAVEKIT\_\* environment variables
    - Support nested keys with double underscore (WAVEKIT_API\_\_PORT)
    - _Requirements: 5.1_

  - [x] 5.2 Implement config file loading from /app/config
    - Load default.yaml as base
    - Merge any custom.yaml if present
    - _Requirements: 5.2_

  - [x] 5.3 Implement environment variable precedence
    - Environment variables override config file values
    - _Requirements: 5.3_

  - [x] 5.4 Add configuration validation with clear error messages
    - Use Zod schema for validation
    - Fail fast on invalid config with descriptive errors
    - _Requirements: 5.4_

  - [x] 5.5 Write property test for config precedence
    - **Property 10: Configuration via Environment Variables with Precedence**
    - **Validates: Requirements 5.1, 5.3**

- [x] 6. Checkpoint - Verify configuration and health systems
  - Test environment variable configuration
  - Test health endpoints return correct status
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement graceful degradation
  - [x] 7.1 Update DecoderManager for failure isolation
    - Continue operating other decoders when one fails
    - Log decoder failures without crashing
    - _Requirements: 10.1_

  - [x] 7.2 Update SourceManager for degraded mode
    - Keep API responsive when source unavailable
    - Report degraded status in health check
    - _Requirements: 10.2, 10.3_

  - [x] 7.3 Implement periodic degraded mode warnings
    - Log warning every 60 seconds while degraded
    - Stop warnings when issue resolved
    - _Requirements: 10.5_

  - [x] 7.4 Write property test for decoder isolation
    - **Property 19: Decoder Failure Isolation**
    - **Validates: Requirements 10.1**

- [x] 8. Implement logging improvements
  - [x] 8.1 Ensure all logs are structured JSON
    - Verify Pino outputs JSON to stdout
    - Include required fields: level, time, component, msg
    - _Requirements: 6.1_

  - [x] 8.2 Add correlation ID support
    - Generate correlation ID for each request
    - Include in all related log entries
    - _Requirements: 6.3_

  - [x] 8.3 Implement secret masking in logs
    - Redact values for _\_SECRET, _\_PASSWORD, _\_KEY, _\_TOKEN env vars
    - _Requirements: 9.6_

  - [x] 8.4 Write property test for log structure
    - **Property 23: Log Entry Structure** (implemented in tests/unit/utils/logger.test.ts)
    - **Validates: Requirements 6.1, 6.3, 13.3**

- [x] 9. Update docker-compose files
  - [x] 9.1 Update docker-compose.dev.yml
    - Add volume mounts for all decoder configs
    - Ensure hot reload works for TypeScript changes
    - _Requirements: 8.1, 8.4_

  - [x] 9.2 Update docker-compose.prod.yml
    - Add resource limits for all services
    - Add security options (no-new-privileges)
    - Add capability restrictions
    - _Requirements: 9.1, 9.2_

- [x] 10. Update documentation
  - [x] 10.1 Update docs/DOCKER-SETUP.md
    - Document all 8 decoders and their configuration
    - Add troubleshooting section for each decoder
    - _Requirements: 1.1_

  - [x] 10.2 Update docker/README.md
    - Add quick reference for all decoder options
    - Update image size estimates
    - _Requirements: 1.1_

- [x] 11. Final checkpoint - Full integration test
  - Build all three image modes (full, core, sdrpp)
  - Verify health checks work correctly
  - Test graceful degradation scenarios
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional property-based tests that can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- The Dockerfile changes (tasks 1.x) should be done together to avoid partial builds
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
