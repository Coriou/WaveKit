#!/usr/bin/env python3
"""Regression harness for scripts/native-patches/rtlmux-server-reconnect.patch.

Upstream slepp/rtlmux 60bc8de frees its rtl_tcp bufferevent on EOF/error (and
on a bad RTL0 header) without clearing the global `serverConnection`; a client
command that arrives before the 1 s reconnect timer fires is written to freed
memory. The patch clears the handle, always records the parameter for replay
after the next RTL0 header, and writes only while the upstream is connected.

Run on Linux with Python 3 only (no radio, no network beyond loopback). A fake
rtl_tcp server sends an RTL0 header plus filler IQ bytes and records every
5-byte command it receives per connection.

  python3 test_rtlmux_reconnect.py --candidate /path/to/patched/rtlmux \
      [--baseline /path/to/unpatched/rtlmux] [--require-baseline-failure]

Scenarios (each starts a fresh rtlmux process):
  down     SET_FREQ while rtl_tcp is down: no crash, then the last frequency
           (and the earlier sample rate) is replayed when rtl_tcp comes back.
  retune   retune while connected (forwarded live), restart rtl_tcp: the new
           frequency is replayed on the new session, not the old one.
  header   a server that answers with a bad magic header: commands sent while
           rtlmux drops it must not crash; replay once a valid server returns.

Memory checking: build with AddressSanitizer, or run plain builds with
--valgrind (authoritative inside uninstrumented libevent); see
run-rtlmux-tests.sh. With --baseline, the unpatched binary must show a memory
error in at least one scenario (proves the harness reaches the bug); a release
binary is checked functionally with --candidate only.
"""

import argparse
import json
import os
import pty
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

SET_FREQ, SET_RATE = 0x01, 0x02
# Logged by the patched serverSendCommand() when it records without writing;
# proves the scenario hit the window between free and reconnect. The unpatched
# binary never logs it and crashes instead.
STORED = 'stored for replay on reconnect'
FILLER = bytes([127]) * 16384


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


TIMEOUT_SCALE = 1.0


def wait_for(predicate, timeout, step=0.05):
    deadline = time.monotonic() + timeout * TIMEOUT_SCALE
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return predicate()


class Session:
    def __init__(self, conn, magic):
        self.conn, self.magic = conn, magic
        self.commands = []
        self.closed = False
        self.lock = threading.Lock()

    def snapshot(self):
        with self.lock:
            return list(self.commands)


class FakeRtlTcp:
    """Minimal rtl_tcp: RTL0 header, continuous filler IQ, records commands."""

    def __init__(self, port):
        self.port = port
        self.sessions = []
        self.listener = None
        self.magic = b'RTL0'
        self.running = False

    def start(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(('127.0.0.1', self.port))
        listener.listen(4)
        listener.settimeout(0.2)
        self.listener, self.running = listener, True
        self.acceptor = threading.Thread(target=self._accept, args=(listener,), daemon=True)
        self.acceptor.start()

    def stop(self):
        self.running = False
        if self.listener:
            # Join the acceptor before closing: a close() racing a blocked
            # accept() keeps the port bound and breaks an immediate restart.
            self.acceptor.join()
            self.listener.close()
            self.listener = None
        for session in self.sessions:
            self._close(session)

    def _close(self, session):
        session.closed = True
        try:
            session.conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        session.conn.close()

    def _accept(self, listener):
        while self.running:
            try:
                conn, _ = listener.accept()
            except (socket.timeout, OSError):
                continue
            if not self.running:
                conn.close()
                break
            session = Session(conn, self.magic)
            self.sessions.append(session)
            threading.Thread(target=self._send, args=(session,), daemon=True).start()
            threading.Thread(target=self._read, args=(session,), daemon=True).start()

    def _send(self, session):
        try:
            # R820T tuner type 5, 29 gain steps, as rtl_tcp announces.
            session.conn.sendall(session.magic + struct.pack('>II', 5, 29))
            while not session.closed:
                session.conn.sendall(FILLER)
                time.sleep(0.01)
        except OSError:
            pass

    def _read(self, session):
        pending = b''
        try:
            while not session.closed:
                chunk = session.conn.recv(4096)
                if not chunk:
                    break
                pending += chunk
                while len(pending) >= 5:
                    cmd, param = struct.unpack('>BI', pending[:5])
                    pending = pending[5:]
                    with session.lock:
                        session.commands.append((cmd, param))
        except OSError:
            pass
        session.closed = True

    def good_sessions(self):
        return [s for s in self.sessions if s.magic == b'RTL0']


class Client:
    """rtl_tcp client of rtlmux: drains IQ, sends 5-byte commands."""

    def __init__(self, port):
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=5)
        # Block while draining: an rtl_tcp outage can exceed any recv timeout.
        self.sock.settimeout(None)
        self.received = 0
        self.closed = False
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        try:
            while True:
                chunk = self.sock.recv(65536)
                if not chunk:
                    break
                self.received += len(chunk)
        except OSError:
            pass
        self.closed = True

    def send(self, cmd, param):
        self.sock.sendall(struct.pack('>BI', cmd, param))

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


WRAPPER = []
# Upstream main.c passes an uninitialised sa_mask to sigaction() at startup.
# Pre-existing and unrelated to the reconnect path; suppress only that frame.
VALGRIND_SUPPRESSION = """{
   rtlmux-main-sigaction-uninitialised-mask
   Memcheck:Param
   rt_sigaction(act->sa_mask)
   ...
   fun:main
}
"""
MEMCHECK_ERRORS = ('Invalid read', 'Invalid write', 'Invalid free', 'Conditional jump', 'Syscall param')


class Rtlmux:
    """rtlmux on a pseudo-terminal: its slog printf() output is then
    line-buffered, so the log reflects events as they happen."""

    def __init__(self, binary, upstream, listen, log_path):
        env = dict(os.environ)
        env.setdefault('ASAN_OPTIONS', 'detect_leaks=0:halt_on_error=1:abort_on_error=0:color=never')
        self.log_path = log_path
        self.log = open(log_path, 'wb')
        self.lock = threading.Lock()
        master, terminal = pty.openpty()
        self.proc = subprocess.Popen(
            [*WRAPPER, binary, '-h', '127.0.0.1', '-p', str(upstream), '-l', str(listen)],
            stdin=subprocess.DEVNULL, stdout=terminal, stderr=terminal, env=env)
        os.close(terminal)
        self.reader = threading.Thread(target=self._copy, args=(master,), daemon=True)
        self.reader.start()

    def _copy(self, master):
        try:
            while True:
                try:
                    chunk = os.read(master, 65536)
                except OSError:  # EIO once the child side is closed
                    break
                if not chunk:
                    break
                with self.lock:
                    self.log.write(chunk)
                    self.log.flush()
        finally:
            os.close(master)

    def alive(self):
        return self.proc.poll() is None

    def output(self):
        with self.lock:
            self.log.flush()
        return Path(self.log_path).read_text(errors='replace')

    def stop(self):
        if self.alive():
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=5 * TIMEOUT_SCALE)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.reader.join(timeout=5)
        with self.lock:
            self.log.close()


class Failure(Exception):
    pass


def check(condition, message):
    if not condition:
        raise Failure(message)


def last(commands, cmd):
    values = [param for code, param in commands if code == cmd]
    return values[-1] if values else None


def start_stack(binary, workdir, name):
    upstream, listen = free_port(), free_port()
    server = FakeRtlTcp(upstream)
    server.start()
    mux = Rtlmux(binary, upstream, listen, str(Path(workdir) / f'{name}.log'))
    # rtlmux binds its client port before it connects upstream.
    check(wait_for(lambda: server.good_sessions(), 15), 'rtlmux never connected to rtl_tcp')
    client = Client(listen)
    check(wait_for(lambda: client.received > 12 + 65536, 15), 'client received no IQ through rtlmux')
    return server, mux, client


def assert_healthy(mux):
    text = mux.output()
    check('AddressSanitizer' not in text, 'AddressSanitizer report: ' + _asan_summary(text))
    check(not any(error in text for error in MEMCHECK_ERRORS), 'valgrind report: ' + _asan_summary(text))
    check(mux.alive(), f'rtlmux exited with status {mux.proc.returncode}')


def _asan_summary(text):
    for line in text.splitlines():
        if ('ERROR: AddressSanitizer' in line or line.startswith('SUMMARY: AddressSanitizer')
                or any(error in line for error in MEMCHECK_ERRORS)):
            return line.strip()
    return 'none'


def _error_stack(text):
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if _asan_summary(line) != 'none':
            return [entry.strip() for entry in lines[index:index + 8]]
    return []


def scenario_down(binary, workdir):
    server, mux, client = start_stack(binary, workdir, 'down')
    try:
        session1 = server.good_sessions()[0]
        client.send(SET_RATE, 2048000)
        check(wait_for(lambda: last(session1.snapshot(), SET_RATE) == 2048000, 10),
              'live SET_RATE was not forwarded while connected')
        server.stop()
        time.sleep(0.3)
        # Spread commands over several 1 s reconnect cycles so they land both
        # in the post-free gap and while a refused reconnect is in flight.
        frequencies = [100_000_000 + index * 25_000 for index in range(8)]
        for frequency in frequencies:
            client.send(SET_FREQ, frequency)
            time.sleep(0.45)
        assert_healthy(mux)
        check(wait_for(lambda: STORED in mux.output(), 5), 'no command landed in the disconnected window')
        check(not client.closed, 'rtlmux dropped its client while rtl_tcp was down')
        before = len(server.sessions)
        server.start()
        check(wait_for(lambda: len(server.sessions) > before, 15), 'rtlmux did not reconnect')
        session2 = server.sessions[-1]
        check(wait_for(lambda: last(session2.snapshot(), SET_FREQ) == frequencies[-1], 10),
              f'frequency not replayed after reconnect: {session2.snapshot()}')
        check(last(session2.snapshot(), SET_RATE) == 2048000, 'sample rate not replayed after reconnect')
        received = client.received
        check(wait_for(lambda: client.received > received + 65536, 10), 'IQ did not resume to the client')
        assert_healthy(mux)
        return {'liveForward': True, 'commandsWhileDown': len(frequencies),
                'replayed': [list(c) for c in session2.snapshot()]}
    finally:
        client.close()
        server.stop()
        mux.stop()


def scenario_retune(binary, workdir):
    server, mux, client = start_stack(binary, workdir, 'retune')
    try:
        session1 = server.good_sessions()[0]
        first, second = 433_920_000, 446_524_920
        client.send(SET_FREQ, first)
        check(wait_for(lambda: last(session1.snapshot(), SET_FREQ) == first, 10), 'first retune not forwarded')
        client.send(SET_FREQ, second)
        check(wait_for(lambda: last(session1.snapshot(), SET_FREQ) == second, 10), 'second retune not forwarded')
        server.stop()
        before = len(server.sessions)
        server.start()
        check(wait_for(lambda: len(server.sessions) > before, 15), 'rtlmux did not reconnect')
        session2 = server.sessions[-1]
        check(wait_for(lambda: last(session2.snapshot(), SET_FREQ) is not None, 10),
              'no frequency replayed after restart')
        time.sleep(0.5)
        check(last(session2.snapshot(), SET_FREQ) == second,
              f'restart did not keep the new frequency: {session2.snapshot()}')
        check(first not in [p for c, p in session2.snapshot() if c == SET_FREQ],
              'stale frequency replayed after restart')
        assert_healthy(mux)
        return {'liveForward': [first, second], 'replayed': [list(c) for c in session2.snapshot()]}
    finally:
        client.close()
        server.stop()
        mux.stop()


def scenario_header(binary, workdir):
    server, mux, client = start_stack(binary, workdir, 'header')
    try:
        server.stop()
        server.magic = b'XXXX'
        before = len(server.sessions)
        server.start()
        check(wait_for(lambda: len(server.sessions) > before, 15), 'rtlmux did not reconnect to the bad server')
        bad = server.sessions[-1]
        check(wait_for(lambda: bad.closed, 10), 'rtlmux kept a connection with a bad magic header')
        frequency = 162_000_000
        for offset in range(6):
            client.send(SET_FREQ, frequency + offset)
            time.sleep(0.4)
        assert_healthy(mux)
        check(wait_for(lambda: STORED in mux.output(), 5), 'no command landed in the disconnected window')
        check(all(code != SET_FREQ for session in server.sessions if session.magic != b'RTL0'
                  for code, _ in session.snapshot()), 'command sent to a server with a bad header')
        server.stop()
        server.magic = b'RTL0'
        before = len(server.sessions)
        server.start()
        check(wait_for(lambda: len(server.sessions) > before, 15), 'rtlmux did not reconnect after bad header')
        good = server.sessions[-1]
        check(wait_for(lambda: last(good.snapshot(), SET_FREQ) == frequency + 5, 10),
              f'frequency not replayed after bad header: {good.snapshot()}')
        assert_healthy(mux)
        return {'badHeaderSessions': len([s for s in server.sessions if s.magic != b'RTL0']),
                'replayed': [list(c) for c in good.snapshot()]}
    finally:
        client.close()
        server.stop()
        mux.stop()


SCENARIOS = {'down': scenario_down, 'retune': scenario_retune, 'header': scenario_header}


def run_all(binary):
    results = {}
    with tempfile.TemporaryDirectory(prefix='rtlmux-test-') as workdir:
        for name, scenario in SCENARIOS.items():
            started = time.monotonic()
            try:
                detail = scenario(binary, workdir)
                results[name] = {'pass': True, **detail}
            except (Failure, OSError) as error:
                # A dead rtlmux surfaces as a reset/refused client socket.
                log = Path(workdir) / f'{name}.log'
                text = log.read_text(errors='replace') if log.exists() else ''
                results[name] = {'pass': False, 'error': f'{type(error).__name__}: {error}',
                                 'memoryError': _asan_summary(text), 'stack': _error_stack(text),
                                 'logTail': text.splitlines()[-4:]}
            results[name]['seconds'] = round(time.monotonic() - started, 2)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--candidate', required=True, help='patched rtlmux binary (must pass every scenario)')
    parser.add_argument('--baseline', help='unpatched rtlmux binary (ASan build expected to fail)')
    parser.add_argument('--require-baseline-failure', action='store_true',
                        help='exit non-zero unless the baseline shows a memory error in a scenario')
    parser.add_argument('--valgrind', action='store_true',
                        help='run rtlmux under valgrind memcheck (use non-ASan builds)')
    parser.add_argument('--timeout-scale', type=float, default=1.0,
                        help='multiply every wait (slow hosts, emulation, valgrind)')
    args = parser.parse_args()
    global TIMEOUT_SCALE
    TIMEOUT_SCALE = args.timeout_scale
    if args.valgrind:
        suppression = Path(tempfile.mkdtemp(prefix='rtlmux-vg-')) / 'rtlmux.supp'
        suppression.write_text(VALGRIND_SUPPRESSION)
        WRAPPER[:] = ['valgrind', '--tool=memcheck', '--leak-check=no', '--error-exitcode=99',
                      f'--suppressions={suppression}']
    report = {'wrapper': WRAPPER, 'candidate': {'binary': args.candidate, 'scenarios': run_all(args.candidate)}}
    ok = all(result['pass'] for result in report['candidate']['scenarios'].values())
    if args.baseline:
        scenarios = run_all(args.baseline)
        # Count only real memory errors, not e.g. the missing STORED log line.
        detected = any(not result['pass'] and result.get('memoryError', 'none') != 'none'
                       for result in scenarios.values())
        report['baseline'] = {'binary': args.baseline, 'scenarios': scenarios, 'bugDetected': detected}
        if args.require_baseline_failure and not detected:
            ok = False
    report['result'] = 'pass' if ok else 'fail'
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write('\n')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
