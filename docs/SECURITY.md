# WaveKit Security Guide

## Access and pairing

Run natively, the core binds `api.host`, which defaults to `0.0.0.0`: every
network interface. Set `api.host: "127.0.0.1"` (or `WAVEKIT_API__HOST`) to keep it on
this machine. The Docker `app` profile publishes its ports on `127.0.0.1` only, so
there the host's loopback is the boundary. To let other devices reach WaveKit, run it
in **protected mode**: every browser is paired once with a one-time code, and every
route, WebSocket and audio stream then needs that paired session (or the machine
credential). The exceptions are the public liveness probes (`/health` and
`/health/live`), `GET /api/access/bootstrap`, which tells a browser it must pair,
and `POST /api/access/pair`, which exchanges the one-time code. Raw audio TCP and
the RTL-TCP relay are disabled in protected mode.

- Try it locally: [Protected mode locally](LOCAL-SETUP.md#protected-mode-locally).
- One container with loopback-published ports:
  [Protected mode in Docker without a forwarder](DOCKER-SETUP.md#protected-mode-in-docker-without-a-forwarder).
- LAN access over HTTPS behind Caddy:
  [Protected reference profile](DOCKER-SETUP.md#protected-reference-profile).
- Configuration fields and the pairing API:
  [Protected runtime](API.md#protected-runtime-opt-in).
- The machine credential for agents and scripts: `access-command.js machine-token`
  copies it into a private `0600` file without a container shell and never prints it.
  It writes inside the directory it checked, never into the private directory even
  if a path is swapped for a link mid-way. It survives restarts while the private
  directory persists. `rotate-credential` is the only revocation. It revokes every
  copy the running private directory could admit, not one restored from before it:
  see [Backups and the fence](#backups-and-the-fence). An export that overlaps a
  rotation can still write the old token to its file; that copy answers 401, so
  export again after the rotation finishes. See
  [Get a machine token](AGENTS-API.md#get-a-machine-token).
- A core that loses its private directory stops admitting: see
  [When a core loses its private directory](#when-a-core-loses-its-private-directory).
- In the default legacy mode the core checks no credential: a token adds nothing, and
  the bind address above is the only boundary.

### When a core loses its private directory

A core proves it still owns the private directory by refreshing a lock file every 10
seconds, and a lock unchanged for 30 seconds can be reclaimed. Only proof of a new owner
latches: the lock file replaced or gone. Another error reading or refreshing it (an I/O
error on a bind mount, say) proves nothing. That check's write is refused, the next
refresh retries, the error is logged and counted, and admission carries on. If the lock
goes unrefreshed for the whole 30 seconds it latches too, because at that age another
owner may take it. A core that was stalled past those 30 seconds (a suspended laptop, say)
still gets 10 seconds to prove the lock is unchanged, and keeps it if it is; a check that
hangs for those 10 seconds latches, and so do errors that last those 10 seconds. One error
right after the stall does not. Three failed refreshes in a row always latch, so a permanent
fault cannot hold the core up for ever.

Once latched, the core exits (below). In the seconds before it does:

- Every bearer, cookie and audio request answers 503 `ACCESS_UNAVAILABLE`: another owner
  may have rotated the credential, so what the core holds in memory proves nothing.
- Open WebSockets, audio streams and downloads are closed, for browser sessions and for
  the machine credential alike. WebSockets get close code 1008, and one that does not
  finish closing within a second is cut.
- `GET /health` answers 503 with `reason` `access_authority_lost`, and `GET /health/live`
  stays 200, until the listener closes.

**The core exits and restarts.** It logs the loss, closes and exits with code 1. A close still
running after 10 seconds ends with SIGKILL, even with file system calls hung. A call that hangs
after the close finished, or one the kernel cannot interrupt, holds the process until it returns.
It exits whatever else is running: a locked-out core cannot be read, steered or stopped by
anyone, and only a new start can load the state another owner may have rotated.

The close differs from a stop in one way: another owner may hold the state and the tuner by
now. From the latch on, the core sends **no tuner frame**: no scanner or temporary tune restore,
no queued write, no reconnect replay, so the receiver stays where it was. It writes **no scanner
state** (jobs, snapshot, journal, engine and occupancy state, trial memory) and **no saved band
gain**; a restart reads what was last on disk, and a scan's recovery record stays there. Sockets,
decoder children and listeners still go. Stores with a lock of their own close as usual, because
that lock still proves them theirs: Activity holds a kernel lock, and band plans and operator
data check their writer lock before each write. Station and decoder settings and recording keeps
start no write on close; they only wait for one already running. The wideband recorder is not
fenced: it finishes its voice files on the way out and can still write its `.analog-operations`
records, which belong to those files.

In the image, s6 starts it again, about 5 seconds after the exit. What you see:

- A recording in progress ends, as on any stop. Finished recordings and every decode so far stay
  on disk. A voice recording closes its file. A named IQ capture in progress loses its partial
  file and its request fails, and a scanner capture in progress is discarded.
- Decoders stop, and their output to external sinks is gone for those seconds. Clients are cut
  off and reconnect once the API is back.
- The tuning is not kept: the core returns to its configured baseline, and a pending
  [temporary tune's restore](API.md#temporary-tune-and-restart) is dropped.
- A running sweep comes back as `paused` with reason `core-restart` and goes on only with
  `resume.onBoot`. A job paused by an operator stays paused.

The new start loads the current credential, or refuses with a stable code if the state needs
repair.

**If another core still owns the directory, the restart is refused, and it keeps trying.** A
refused start never touches the tuner: it checks the locks and opens the private directory
before it creates any source. Each failed exit waits 4 seconds in the finish script, and s6
starts the service at most once a second, so the attempts run at:

| The other owner       | Refusal                                                      | Time for one attempt                                                       | Attempts            |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------- |
| In the same container | `ACCESS_STORAGE_BUSY`, at once                               | At least 1 s of start and 4 s of wait: 5 s or more                         | at most 720 an hour |
| In another container  | `ACCESS_STORAGE_FOREIGN_OWNER`, after watching its heartbeat | 40 s + 40 s (the startup check, then the open) and 4 s of wait: about 85 s | about 40 an hour    |

Each attempt logs a few lines: `Starting WaveKit`, the refusal with its code (and, in the second
case, two `Waiting for storage lock heartbeat` lines), and a start and stop line in
`/var/log/wavekit/system.log`. A volume that stays broken loops the same way. `/health` stays
down meanwhile, and the logs say why. Stop the other core and the next attempt succeeds.

Run natively, as with `make dev-protected` or `node dist/index.js`, nothing restarts the process:
it ends with code 1 and that log line, and you start it again. `make dev-protected` ends with its
server, so it deletes its throwaway directory as on any other exit.

Band plans and operator data have locks of their own under the same rule. Losing one of those
touches no credential: only that store goes unavailable until a restart.

Two gaps stay open:

- **Detection is not instant.** A latch comes at the first check after the event: up to 10
  seconds after the lock is replaced or removed under a running core. A core that was stalled
  (a paused container) and lost the directory meanwhile runs that check first thing on
  resuming, and it takes one file system round trip, usually a few milliseconds. A request
  that reaches the core in that window is checked against the old credential and can be
  admitted, and a stream it opens lasts until the check finishes.
- **A request already admitted finishes.** A plain HTTP request past admission when the latch
  comes gets its answer, and a write already running or queued at a store can still land. No
  fencing token stops it.

### Backups and the fence

Every rotation first records a hash of the new credential in `credential-fence.json` in the
private directory. A stored credential that does not match it is refused with
`ACCESS_STORAGE_CREDENTIAL_MISMATCH`, so a stalled core's late write cannot bring a revoked
token back: a restart refuses until you run `rotate-credential` again.

The fence is only as current as the directory it sits in:

- **After restoring a private volume from backup, rotate before starting the core.** A full
  restore brings back the fence with the state it matched, from before any later rotation, so
  every token revoked since is accepted again until you rotate. Nothing outside the volume can
  tell the core otherwise. Export the token again afterwards.
- **Never delete the fence.** Without it, a stale state file loads with nothing to compare it
  against, and a revoked token works again.

A fence that is unsafe (mode not `0600`, wrong owner, a link, a directory, oversized) refuses
load and rotation with `ACCESS_STORAGE_UNSAFE`, and changes nothing. A volume copied without
its modes reaches this. With the core stopped:

1. If only the mode or owner is wrong, repair them: `chown` it to the core's user and
   `chmod 600 credential-fence.json`; the directory itself is `0700`. Then start the core. The
   same repair applies when another file in the directory reports this code.
2. If it is a link, a directory or oversized, its content cannot be trusted. Move it out of the
   private directory and run `rotate-credential` straight away, before the core starts: that
   writes a new fence and revokes every older token, so nothing was opened by going without one.
   Then export the token again. Every browser pairs again.

## Decoder versions

WaveKit integrates multiple third-party decoder binaries (dsd-fme, multimon-ng, rtl_433, readsb, acarsdec, dumpvdl2, AIS-catcher, Dire Wolf, gr-lora_sdr). These external dependencies require careful version management and security monitoring to maintain a secure deployment.

This document covers:

1. [Version Pinning Best Practices](#version-pinning-best-practices)
2. [Security Advisory Tracking Process](#security-advisory-tracking-process)
3. [Known Security Advisories](#known-security-advisories)
4. [Incident Response](#incident-response)

---

## Version Pinning Best Practices

### Why Version Pinning Matters

Decoder binaries process untrusted radio signals and can be vulnerable to:

- Buffer overflows from malformed packets
- Denial of service from crafted signals
- Remote code execution in parsing logic
- Memory corruption from unexpected input

Version pinning ensures:

- **Reproducibility**: Deployments behave consistently across environments
- **Security**: Known-vulnerable versions can be blocked
- **Stability**: Unexpected behavior from untested versions is prevented

### Configuration

WaveKit supports version constraints via the `minVersion` and `maxVersion` fields in decoder configuration:

```yaml
# your config, e.g. config/custom.yaml
decoders:
  - id: direwolf
    type: direwolf
    enabled: true
    # Version pinning - REQUIRED for security
    minVersion: "1.7.1" # Minimum safe version (post-CVE fix)
    maxVersion: "1.8.0" # Maximum tested version
    options:
      kissPort: 8001

  - id: dsd
    type: dsd-fme
    enabled: true
    minVersion: "2.0.0"
    options:
      mode: auto
```

### Version Constraint Guidelines

| Constraint        | When to Use                     | Example                                    |
| ----------------- | ------------------------------- | ------------------------------------------ |
| `minVersion` only | Block known-vulnerable versions | `minVersion: "1.7.1"`                      |
| `maxVersion` only | Limit to tested versions        | `maxVersion: "2.0.0"`                      |
| Both              | Production deployments          | `minVersion: "1.7.1", maxVersion: "1.8.0"` |
| Neither           | Development/testing only        | Not recommended for production             |

### Validation Behavior

When WaveKit starts, it validates decoder versions:

1. **Version Detection**: Runs decoder with `--version` flag
2. **Constraint Check**: Compares against configured min/max
3. **Warning/Error**: Logs appropriate message with upgrade instructions

```
# Example log output for version mismatch
WARN [DecoderManager] Decoder direwolf version 1.6.0 is below minimum required version 1.7.1. Please upgrade direwolf to version 1.7.1 or higher.
```

### Recommended Version Constraints

| Decoder     | Min Version | Max Version | Notes                         |
| ----------- | ----------- | ----------- | ----------------------------- |
| direwolf    | 1.7.1       | -           | CVE-2025-34458 fixed in 1.7.1 |
| dsd-fme     | 2.0.0       | -           | Stable release                |
| multimon-ng | 1.2.0       | -           | Stable release                |
| rtl_433     | 23.11       | -           | Active development            |
| readsb      | 3.14.0      | -           | Modern ADS-B stack            |
| acarsdec    | 3.7.0       | -           | Maintained fork               |
| dumpvdl2    | 2.5.0       | -           | Stable release                |
| AIS-catcher | 0.50        | -           | Active development            |

---

## Security Advisory Tracking Process

### Monitoring Sources

WaveKit operators should monitor these sources for security advisories:

1. **National Vulnerability Database (NVD)**
   - URL: https://nvd.nist.gov/
   - Search for decoder names (e.g., "direwolf", "rtl_433")

2. **GitHub Security Advisories**
   - Check each decoder's GitHub repository
   - Enable "Watch" → "Security alerts" for repositories

3. **Decoder Mailing Lists / Forums**
   - Many decoders have dedicated mailing lists
   - SDR-focused forums often discuss vulnerabilities

4. **WaveKit Security Announcements**
   - Check WaveKit repository releases for security notes
   - Subscribe to WaveKit security mailing list (if available)

### Monthly Security Review Process

Perform this review monthly (or more frequently for critical systems):

#### Step 1: Check for New Advisories

```bash
# Search NVD for decoder-related CVEs
# Visit: https://nvd.nist.gov/vuln/search
# Search terms: direwolf, rtl_433, multimon-ng, dsd-fme, readsb, acarsdec, dumpvdl2, AIS-catcher
```

#### Step 2: Review Decoder Releases

Check each decoder's release page for security-related updates:

| Decoder     | Release Page                                         |
| ----------- | ---------------------------------------------------- |
| direwolf    | https://github.com/wb2osz/direwolf/releases          |
| dsd-fme     | https://github.com/lwvmobile/dsd-fme/releases        |
| multimon-ng | https://github.com/EliasOeworsl/multimon-ng/releases |
| rtl_433     | https://github.com/merbanan/rtl_433/releases         |
| readsb      | https://github.com/wiedehopf/readsb/releases         |
| acarsdec    | https://github.com/TLeconte/acarsdec/releases        |
| dumpvdl2    | https://github.com/szpajder/dumpvdl2/releases        |
| AIS-catcher | https://github.com/jvde-github/AIS-catcher/releases  |

#### Step 3: Update Version Constraints

If a security issue is found:

1. Identify the fixed version
2. Update `minVersion` in configuration
3. Test the new version in a staging environment
4. Deploy to production
5. Document the change in your change log

#### Step 4: Document Findings

Maintain a security log with:

- Date of review
- Advisories found (if any)
- Actions taken
- Next review date

### Automated Monitoring (Recommended)

For production deployments, consider:

1. **Dependabot/Renovate**: Configure for Docker base images
2. **CVE Monitoring Services**: Snyk, Trivy, or similar
3. **Custom Scripts**: Periodic version checks against known-good lists

Example monitoring script:

```bash
#!/bin/bash
# check-decoder-versions.sh
# Run periodically via cron

DECODERS=("direwolf" "dsd-fme" "multimon-ng" "rtl_433")
MIN_VERSIONS=("1.7.1" "2.0.0" "1.2.0" "23.11")

for i in "${!DECODERS[@]}"; do
    decoder="${DECODERS[$i]}"
    min_version="${MIN_VERSIONS[$i]}"

    # Check if decoder is installed and get version
    # (Implementation depends on decoder)
    echo "Checking $decoder >= $min_version"
done
```

---

## Known Security Advisories

### Active Advisories

| CVE            | Decoder  | Severity | Fixed Version | Description                            |
| -------------- | -------- | -------- | ------------- | -------------------------------------- |
| CVE-2025-34458 | direwolf | HIGH     | 1.7.1         | Buffer overflow in APRS packet parsing |

### Mitigations

#### CVE-2025-34458 (Direwolf)

**Affected Versions**: < 1.7.1

**Description**: A buffer overflow vulnerability in Direwolf's APRS packet parsing could allow remote code execution via crafted APRS packets.

**Mitigation**:

1. **Upgrade** to direwolf 1.7.1 or later (recommended)
2. **Configure version constraint**:
   ```yaml
   decoders:
     - id: direwolf
       type: direwolf
       minVersion: "1.7.1"
   ```
3. **Network isolation**: If upgrade is not immediately possible, isolate the decoder from untrusted networks

**References**:

- NVD: https://nvd.nist.gov/vuln/detail/CVE-2025-34458
- GitHub Advisory: Check direwolf repository

---

## Incident Response

### If a Vulnerability is Discovered

1. **Assess Impact**
   - Is the vulnerable decoder enabled in your deployment?
   - Is the vulnerability exploitable in your environment?
   - What data/systems could be affected?

2. **Immediate Mitigation**
   - Disable the affected decoder if not critical
   - Apply network-level controls (firewall rules)
   - Update version constraints to block vulnerable versions

3. **Remediation**
   - Update to patched version
   - Test in staging environment
   - Deploy to production
   - Verify fix is applied

4. **Post-Incident**
   - Document the incident
   - Update monitoring to catch similar issues
   - Review other decoders for similar vulnerabilities

### Emergency Contacts

Maintain a list of contacts for security incidents:

- WaveKit maintainers: [GitHub Issues](https://github.com/Coriou/WaveKit/issues)
- Decoder maintainers: See GitHub repositories above
- Your organization's security team

---

## Security Checklist

Use this checklist for new deployments:

- [ ] All decoders have `minVersion` configured
- [ ] Version constraints block known-vulnerable versions
- [ ] Security advisory monitoring is set up
- [ ] Monthly security review is scheduled
- [ ] Incident response contacts are documented
- [ ] Docker images use pinned base image versions
- [ ] Network isolation is configured appropriately
- [ ] Logging captures version validation warnings

---

## References

- [NIST National Vulnerability Database](https://nvd.nist.gov/)
- [GitHub Security Advisories](https://github.com/advisories)
- [WaveKit Decoder Guide](./DECODER-GUIDE.md)
- [CVE-2025-34458 (Direwolf)](https://nvd.nist.gov/vuln/detail/CVE-2025-34458)
