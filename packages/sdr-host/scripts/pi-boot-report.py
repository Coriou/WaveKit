#!/usr/bin/python3
"""Record, once per boot, how the previous boot ended and the power state now.

On 2026-10-09 a Pi rebooted about two minutes after a dongle re-plug on battery
and nothing could tell a brownout from a crash. This writes a small sanitized
record into the status directory that compose mounts read-only, so the status
page can say so. Facts only; each one is null when it cannot be read:

- previous boot (needs the persistent journal): its last journal entry, and
  whether it reached shutdown.target, i.e. a requested reboot or power-off;
- firmware throttle flags read now: under-voltage or throttling since this
  boot's power-on;
- a watchdog reset, only when the watchdog driver flags one.

The journal is ordinary kernel and service logging; nothing from it but two
timestamps and a boolean leaves this script.
"""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

STATUS = Path('/var/lib/wavekit/status')
RECORD = 'last-boot.json'
BOOT_ID = Path('/proc/sys/kernel/random/boot_id')
THROTTLED_SYSFS = Path('/sys/devices/platform/soc/soc:firmware/get_throttled')
WATCHDOG_STATUS = Path('/sys/class/watchdog/watchdog0/bootstatus')
WDIOF_CARDRESET = 0x20
# systemd's "Journal stopped" message: journald only writes it on a clean stop.
JOURNAL_STOPPED = 'd93fb3c9c24d451a97cea615ce59c00b'
TAIL = 50


def run(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout if result.returncode == 0 else None


def iso(microseconds):
    moment = datetime.datetime.fromtimestamp(int(microseconds) / 1e6, datetime.timezone.utc)
    return moment.isoformat(timespec='seconds')


def previous_boot(runner=run):
    """How the previous boot ended, from the tail of its journal."""
    text = runner(['journalctl', '--no-pager', '-q', '-b', '-1', '-n', str(TAIL), '-o', 'json',
                   '--output-fields=__REALTIME_TIMESTAMP,UNIT,MESSAGE_ID,_PID'])
    if not text:
        return None
    try:
        entries = [json.loads(line) for line in text.splitlines() if line.strip()]
        last = int(entries[-1]['__REALTIME_TIMESTAMP'])
    except (ValueError, KeyError, IndexError, TypeError):
        return None
    clean = any(entry.get('MESSAGE_ID') == JOURNAL_STOPPED
                or (entry.get('_PID') == '1' and entry.get('UNIT') == 'shutdown.target')
                for entry in entries)
    return {'lastEntryAt': iso(last), 'cleanShutdown': clean}


def throttled(runner=run, sysfs=THROTTLED_SYSFS):
    """Firmware flags: bit 16 under-voltage and bit 18 throttling since power-on."""
    text = runner(['vcgencmd', 'get_throttled'])
    value = text.strip().partition('=')[2] if text else None
    if not value:
        try:
            value = sysfs.read_text().strip()
        except OSError:
            return None
    try:
        flags = int(value, 16)
    except ValueError:
        return None
    return {'undervoltageSinceBoot': bool(flags & 1 << 16), 'throttledSinceBoot': bool(flags & 1 << 18)}


def watchdog_reset(path=WATCHDOG_STATUS):
    """True only when the driver says so; drivers that never set it stay unknown."""
    try:
        return True if int(path.read_text().strip()) & WDIOF_CARDRESET else None
    except (OSError, ValueError):
        return None


def report(runner=run, boot_id_path=BOOT_ID, sysfs=THROTTLED_SYSFS, watchdog=WATCHDOG_STATUS):
    try:
        boot_id = boot_id_path.read_text().strip()[:64] or None
    except OSError:
        boot_id = None
    flags = throttled(runner, sysfs)
    return {
        'schema': 1,
        'bootId': boot_id,
        'writtenAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'previous': previous_boot(runner),
        'undervoltageSinceBoot': flags['undervoltageSinceBoot'] if flags else None,
        'throttledSinceBoot': flags['throttledSinceBoot'] if flags else None,
        'watchdogReset': watchdog_reset(watchdog),
    }


def write(record, directory=STATUS):
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / f'.{RECORD}.tmp'
    temporary.write_text(json.dumps(record) + '\n')
    temporary.chmod(0o644)
    # Atomic rename: the status page never reads a partial record.
    os.replace(temporary, directory / RECORD)


def main():
    record = report()
    write(record)
    previous = record['previous']
    print('previous boot: ' + ('none in the journal' if previous is None else
          f"last entry {previous['lastEntryAt']}, {'clean shutdown' if previous['cleanShutdown'] else 'ended without shutdown'}"))
    return 0


if __name__ == '__main__':
    sys.exit(main())
