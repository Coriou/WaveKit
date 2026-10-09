"""File-only installer acceptance; all mutable paths live in temporary fixtures."""
import argparse
import hashlib
import gzip
import http.client
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import io
import json
import shutil
from pathlib import Path
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'packages/sdr-host/scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load('pi_image_builder', 'build-pi-image.py')
firstboot = load('pi_image_firstboot', 'pi-image-firstboot.py')
boot_status = load('pi_boot_status', 'pi-boot-status.py')
boot_report = load('pi_boot_report', 'pi-boot-report.py')


class ImageBuilderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wavekit-image-test-')
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_promotes_only_completed_workspace_images_without_overwriting_old_candidates(self):
        workspace = self.root / 'project'
        candidate = workspace / 'output/operator-next'
        candidate.mkdir(parents=True)
        pointer = workspace / 'output/pi-image-current.json'
        pointer.write_text('{"manifest":"previous/os-list.json"}')
        with self.assertRaises(FileNotFoundError):
            builder.select_default(candidate, workspace)
        self.assertEqual(json.loads(pointer.read_text())['manifest'], 'previous/os-list.json')
        for name in ('os-list.json', 'BUILD.json', 'wavekit-sdr-host.img.xz'):
            (candidate / name).write_text('fixture')
        previous = workspace / 'output/previous'
        previous.mkdir()
        (previous / 'wavekit-sdr-host.img.xz').write_text('older candidate')
        builder.select_default(candidate, workspace)
        self.assertEqual(json.loads(pointer.read_text())['manifest'], 'operator-next/os-list.json')
        self.assertEqual((previous / 'wavekit-sdr-host.img.xz').read_text(), 'older candidate')
        builder.select_default(self.root / 'external', workspace)
        self.assertEqual(json.loads(pointer.read_text())['manifest'], 'operator-next/os-list.json')

    def bundle(self, architecture='arm64'):
        bundle = self.root / 'bundle'
        bundle.mkdir()
        for name in builder.PAYLOAD:
            (bundle / name).write_text('fixture\n')
        (bundle / 'IMAGE.txt').write_text('wavekit-sdr-host:pi-local\n')
        with tarfile.open(bundle / 'wavekit-sdr-host-image.tar.gz', 'w:gz') as archive:
            for name, value in [('manifest.json', [{'Config': 'config.json', 'RepoTags': ['wavekit-sdr-host:pi-local']}]),
                                ('config.json', {'os': 'linux', 'architecture': architecture})]:
                data = json.dumps(value).encode()
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        (bundle / 'SHA256SUMS').write_text(''.join(f'{builder.digest(bundle / name)}  {name}\n' for name in builder.PAYLOAD))
        return bundle

    def image(self):
        image = self.root / 'base.img'
        data = bytearray(8192)
        data[510:512] = b'\x55\xaa'
        data[450] = 0x0c
        struct.pack_into('<II', data, 454, 1, 3)
        data[466] = 0x83
        struct.pack_into('<II', data, 470, 4, 12)
        image.write_bytes(data)
        return image

    def test_validates_bounded_partitions(self):
        self.assertEqual(builder.partitions(self.image()), (2048, 8192))

    def test_rejects_overlap_and_out_of_bounds(self):
        image = self.image()
        for start, count in [(3, 13), (4, 100)]:
            data = bytearray(image.read_bytes())
            struct.pack_into('<II', data, 470, start, count)
            image.write_bytes(data)
            with self.assertRaises(ValueError):
                builder.partitions(image)

    def test_rejects_block_like_inputs_and_symlinks(self):
        link = self.root / 'link'
        link.symlink_to(self.image())
        with self.assertRaises(ValueError):
            builder.partitions(link)

    def test_checks_every_payload_and_architecture(self):
        bundle = self.bundle()
        self.assertGreater(builder.verify_bundle(bundle), 0)
        (bundle / 'setup.sh').write_text('corrupted')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            builder.verify_bundle(bundle)

    def test_rejects_non_arm64_archive(self):
        with self.assertRaisesRegex(ValueError, 'ARM64'):
            builder.verify_bundle(self.bundle('amd64'))

    def test_hash_failure_precedes_filesystem_mutation_and_preserves_output(self):
        base = self.root / 'base.img.xz'
        base.write_bytes(b'fixture-compressed')
        output = self.root / 'output'
        output.mkdir()
        prior = output / 'wavekit-sdr-host.img.xz'
        prior.write_bytes(b'previous-artifact')
        args = argparse.Namespace(base=base, bundle=self.bundle(), output=output,
                                  base_sha256='0' * 64, e2fsprogs=None)
        def mock_run(command, **kwargs):
            kwargs['stdout'].write(b'wrong-image')
            return subprocess.CompletedProcess(command, 0)
        with patch.object(builder, 'tool', return_value='fixture-tool'), patch.object(builder.subprocess, 'run', side_effect=mock_run) as run:
            with self.assertRaisesRegex(ValueError, 'SHA256'):
                builder.build(args)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(prior.read_bytes(), b'previous-artifact')
        self.assertEqual(list(output.iterdir()), [prior])

    def test_refuses_unclean_filesystem(self):
        with patch.object(builder.subprocess, 'run', return_value=subprocess.CompletedProcess([], 4)):
            with self.assertRaisesRegex(ValueError, 'not clean'):
                builder.check_clean(self.root / 'root', 'e2fsck')

    def test_service_avoids_multi_user_target_cycle(self):
        unit = (ROOT / 'packages/sdr-host/scripts/wavekit-firstboot.service').read_text()
        self.assertIn('After=cloud-final.service', unit)
        self.assertIn('WantedBy=cloud-init.target', unit)
        self.assertNotIn('WantedBy=multi-user.target', unit)


class ImageFirstbootTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wavekit-image-firstboot-')
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.boot, self.home = self.root / 'boot', self.root / 'home'
        self.boot.mkdir()
        self.home.mkdir()
        (self.boot / 'config.txt').write_text('fixture')
        self.bundle = self.root / 'bundle'
        self.bundle.mkdir()
        (self.bundle / 'setup.sh').write_text('fixture')
        self.config = self.root / 'cloud-config'
        self.config.write_text(json.dumps({'user': {'name': 'operator', 'sudo': ['ALL=(ALL) ALL']}}))
        self.account = types.SimpleNamespace(pw_name='operator', pw_uid=1000, pw_gid=1000, pw_dir=str(self.home))
        self.boot_id = self.root / 'boot_id'
        self.expect_record = True
        self.boot_id.write_text('fixture-boot-id\n')
        for name, value in [('BUNDLE', self.bundle), ('STATE', self.root / 'state'), ('LOG', self.root / 'log'),
                            ('BOOT_PATHS', (self.boot,)), ('CONFIG', self.config), ('BOOT_ID', self.boot_id)]:
            context = patch.object(firstboot, name, value)
            context.start()
            self.addCleanup(context.stop)
        for context in [patch.object(firstboot.os, 'geteuid', return_value=0),
                        patch.object(firstboot.os, 'chown'),
                        patch.object(firstboot.pwd, 'getpwnam', return_value=self.account),
                        patch.dict(sys.modules, {'yaml': types.SimpleNamespace(safe_load=json.loads)})]:
            context.start()
            self.addCleanup(context.stop)

    def run_setup(self, fail=False, cloud_report=None, cloud_code=0):
        def command(command, **kwargs):
            if command[0] == 'cloud-init':
                report = cloud_report if cloud_report is not None else {
                    'status': 'done', 'extended_status': 'done',
                    'errors': [], 'recoverable_errors': {},
                }
                return subprocess.CompletedProcess(command, cloud_code, json.dumps(report))
            if command[0] == 'bash':
                self.assertEqual(command, ['bash', './setup.sh', '--target-user', 'operator'])
                self.assertIn('running', (self.boot / 'wavekit-setup.status').read_text())
                if self.expect_record:
                    self.assertEqual(self.setup_record()['phase'], 'install')
                self.assertEqual(kwargs['cwd'], firstboot.STATE / 'install/wavekit-pi-bundle')
                self.assertEqual(kwargs['cwd'].parent.stat().st_mode & 0o777, 0o700)
                kwargs['stdout'].write('fixture setup output\n')
                if fail:
                    raise subprocess.CalledProcessError(23, command)
            elif command[0] == 'runuser':
                if command[4] == 'mkdir':
                    Path(command[-1]).mkdir(parents=True, exist_ok=True)
                elif command[4] == 'cp':
                    shutil.copytree(firstboot.STATE / 'install/wavekit-pi-bundle', Path(command[-1]), dirs_exist_ok=True)
            return subprocess.CompletedProcess(command, 0)
        with patch.object(firstboot.subprocess, 'run', side_effect=command) as run:
            return firstboot.main(), run.call_count

    def setup_record(self):
        return json.loads((firstboot.STATE / 'status/setup.json').read_text())

    def test_status_page_record_is_allowlisted_and_world_readable(self):
        self.assertEqual(self.run_setup(), (0, 4))
        record = self.setup_record()
        self.assertEqual(set(record), {'schema', 'state', 'phase', 'updatedAt', 'bootId', 'exitCode'})
        self.assertEqual((record['state'], record['phase'], record['exitCode']), ('complete', 'done', 0))
        self.assertEqual(record['bootId'], 'fixture-boot-id')
        status_dir = firstboot.STATE / 'status'
        self.assertEqual(sorted(path.name for path in status_dir.iterdir()), ['setup.json'])
        self.assertEqual(status_dir.stat().st_mode & 0o777, 0o755)
        self.assertEqual((status_dir / 'setup.json').stat().st_mode & 0o777, 0o644)
        self.assertNotIn('operator', (status_dir / 'setup.json').read_text())

    def test_status_page_record_reports_failure_without_details(self):
        self.assertEqual(self.run_setup(fail=True), (23, 2))
        record = self.setup_record()
        self.assertEqual((record['state'], record['phase'], record['exitCode']), ('failed', None, 23))
        self.assertNotIn('fixture setup output', json.dumps(record))

    def test_status_page_record_failure_never_fails_setup(self):
        self.expect_record = False
        with patch.object(firstboot, 'write_setup_status', side_effect=PermissionError):
            self.assertEqual(self.run_setup(), (0, 4))
        self.assertIn('Could not publish status page record', firstboot.LOG.read_text())

    def test_root_setup_uses_top_level_imager_user_and_copies_status_logs(self):
        self.assertEqual(self.run_setup(), (0, 4))
        self.assertTrue((firstboot.STATE / 'firstboot.done').exists())
        self.assertIn('complete', (self.boot / 'wavekit-setup.status').read_text())
        self.assertEqual((self.boot / 'wavekit-setup.log').read_text(), firstboot.LOG.read_text())

    def test_failure_publishes_diagnostics_and_retry_succeeds(self):
        self.assertEqual(self.run_setup(fail=True), (23, 2))
        self.assertFalse((firstboot.STATE / 'firstboot.done').exists())
        self.assertIn('failed', (self.boot / 'wavekit-setup.status').read_text())
        self.assertIn('fixture setup output', (self.boot / 'wavekit-setup.log').read_text())
        self.assertEqual(self.run_setup(), (0, 4))

    def test_rerun_keeps_user_settings_and_skips_setup(self):
        self.assertEqual(self.run_setup(), (0, 4))
        settings = self.home / 'wavekit-pi-bundle/.env'
        settings.write_text('fixture override')
        self.assertEqual(self.run_setup(), (0, 0))
        self.assertEqual(settings.read_text(), 'fixture override')

    def test_users_list_supported_and_ambiguity_rejected(self):
        self.assertEqual(firstboot.configured_user({'users': [{'name': 'operator'}]}), self.account)
        with self.assertRaises(ValueError):
            firstboot.configured_user({'users': [{'name': 'one'}, {'name': 'two'}]})
        with self.assertRaises(ValueError):
            firstboot.configured_user({'users': ['default']})

    def test_no_privilege_bypass_or_secret_parser_errors(self):
        with patch.object(firstboot.os, 'geteuid', return_value=1000):
            self.assertEqual(firstboot.main(), 1)
        self.assertFalse(firstboot.STATE.exists())
        self.config.write_text('fixture-secret-invalid-config')
        self.assertEqual(self.run_setup(), (1, 1))
        self.assertNotIn('fixture-secret-invalid-config', firstboot.LOG.read_text())

    def test_missing_bundle_and_destination_symlink_fail_safely(self):
        (self.bundle / 'setup.sh').unlink()
        self.assertEqual(self.run_setup(), (1, 1))
        self.assertIn('failed', (self.boot / 'wavekit-setup.status').read_text())
        (self.bundle / 'setup.sh').write_text('fixture')
        destination = self.home / 'wavekit-pi-bundle'
        destination.symlink_to(self.root)
        self.assertEqual(self.run_setup(), (1, 1))

    def test_reviewed_missing_module_warning_allows_setup(self):
        report = {'status': 'done', 'extended_status': 'degraded done',
                  'errors': [], 'recoverable_errors': {'WARNING': [firstboot.KNOWN_CLOUD_WARNING]}}
        report['modules-final'] = {'errors': [], 'recoverable_errors': report['recoverable_errors']}
        self.assertEqual(self.run_setup(cloud_report=report, cloud_code=2), (0, 4))
        self.assertIn('reviewed missing cc_netplan_nm_patch', firstboot.LOG.read_text())
        self.assertTrue((firstboot.STATE / 'firstboot.done').exists())

    def test_unreviewed_or_incomplete_cloud_init_never_installs(self):
        good = {'status': 'done', 'extended_status': 'degraded done',
                'errors': [], 'recoverable_errors': {'WARNING': [firstboot.KNOWN_CLOUD_WARNING]}}
        reports = [
            {**good, 'status': 'running'},
            {**good, 'extended_status': 'error - done'},
            {**good, 'errors': ['fixture-secret-error']},
            {**good, 'recoverable_errors': {'WARNING': [firstboot.KNOWN_CLOUD_WARNING, 'fixture-secret-warning']}},
            {**good, 'recoverable_errors': {}},
            {**good, 'modules-final': {'errors': ['fixture-secret-stage-error'], 'recoverable_errors': {}}},
            {**good, 'recoverable_errors': {'ERROR': [firstboot.KNOWN_CLOUD_WARNING]}},
            {**good, 'recoverable_errors': {'WARNING': firstboot.KNOWN_CLOUD_WARNING}},
        ]
        for report in reports:
            with self.subTest(report=report):
                self.assertEqual(self.run_setup(cloud_report=report, cloud_code=2), (1, 1))
                self.assertFalse((firstboot.STATE / 'firstboot.done').exists())
                self.assertIn('failed', (self.boot / 'wavekit-setup.status').read_text())
                self.assertNotIn('fixture-secret', firstboot.LOG.read_text())
                self.assertFalse((firstboot.STATE / 'install').exists())

    def test_cloud_init_fatal_and_malformed_results_never_install(self):
        for code, output in [(1, '{}'), (2, 'fixture-secret-invalid-json')]:
            with patch.object(firstboot.subprocess, 'run', return_value=subprocess.CompletedProcess([], code, output)) as run:
                self.assertEqual(firstboot.main(), 1)
            self.assertEqual(run.call_count, 1)
            self.assertFalse((firstboot.STATE / 'install').exists())
            self.assertNotIn('fixture-secret', firstboot.LOG.read_text())

    def test_cloud_init_recoverable_error_requires_review_and_never_runs_setup(self):
        with patch.object(firstboot.subprocess, 'run', side_effect=subprocess.CalledProcessError(2, ['cloud-init'])) as run:
            self.assertEqual(firstboot.main(), 2)
        self.assertEqual(run.call_count, 1)
        self.assertIn('failed', (self.boot / 'wavekit-setup.status').read_text())
        self.assertFalse((firstboot.STATE / 'firstboot.done').exists())


class BootStatusTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wavekit-boot-status-')
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.status, self.boot = self.root / 'setup.json', self.root / 'boot_id'
        self.boot.write_text('current-boot')
        self.record = {'schema': 1, 'state': 'running', 'phase': 'install',
                       'updatedAt': '2026-01-01T12:00:00+00:00',
                       'bootId': 'current-boot', 'exitCode': None}

    def read(self, **values):
        self.status.write_text(json.dumps({**self.record, **values}))
        return boot_status.setup_status(self.status, self.boot)

    def test_waits_before_cloud_init_and_exposes_only_sanitized_values(self):
        self.assertEqual(boot_status.setup_status(self.status, self.boot)['state'], 'waiting')
        result = self.read(password='fixture-secret', logs='fixture-private-log')
        self.assertEqual(result['state'], 'running')
        self.assertEqual(set(result), {'state', 'phase', 'updatedAt', 'updatedAgeMs', 'exitCode'})
        self.assertNotIn('fixture', json.dumps(result))
        self.assertEqual(self.read(state='failed', phase=None, exitCode=23)['exitCode'], 23)

    def test_interrupted_boot_is_not_reported_as_running(self):
        self.assertEqual(self.read(bootId='previous-boot')['state'], 'interrupted')
        self.assertEqual(self.read(bootId='previous-boot', state='complete')['state'], 'complete')

    def test_rejects_symlink_directory_oversized_or_malformed_records(self):
        target = self.root / 'private'
        target.write_text('fixture-secret')
        self.status.symlink_to(target)
        self.assertEqual(boot_status.setup_status(self.status, self.boot)['state'], 'unavailable')
        self.status.unlink()
        self.status.mkdir()
        self.assertEqual(boot_status.setup_status(self.status, self.boot)['state'], 'unavailable')
        self.status.rmdir()
        for text in ('x' * 4097, 'not-json', '[]', '{}'):
            self.status.write_text(text)
            self.assertEqual(boot_status.setup_status(self.status, self.boot)['state'], 'unavailable')
        for change in ({'updatedAt': '2026-01-01'}, {'phase': 'fixture-secret'}, {'exitCode': True}):
            self.assertEqual(self.read(**change)['state'], 'unavailable')

    def server(self, probe=None):
        probe = probe or types.SimpleNamespace(available=lambda: False, port=1)
        server = boot_status.StatusServer(('127.0.0.1', 0), ROOT / 'packages/sdr-host/ui', self.status, self.boot, probe)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def request(self, server, path, method='GET', headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_http_serves_page_before_receiver_and_never_serves_private_files(self):
        server = self.server()
        code, headers, body = self.request(server, '/', headers={'Accept-Encoding': 'gzip'})
        self.assertEqual(code, 200)
        self.assertIn(b'First-boot setup', gzip.decompress(body))
        self.assertIn("default-src 'none'", headers['Content-Security-Policy'])
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        code, _, body = self.request(server, '/api/setup')
        self.assertEqual(json.loads(body)['state'], 'waiting')
        self.assertFalse(json.loads(body)['receiverPageReady'])
        for path in ('/../setup.json', '/%2e%2e/setup.json', '/boot/firmware/user-data', '/api/fix', '//etc/passwd'):
            self.assertEqual(self.request(server, path)[0], 404)
        self.assertEqual(self.request(server, '/api/setup', method='POST')[0], 501)
        self.assertEqual(self.request(server, '/', method='HEAD')[2], b'')

    def receiver(self):
        """A stand-in for the receiver's own server on its loopback port."""
        seen = []

        class Receiver(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                seen.append((self.command, self.path, self.headers.get('Host'), self.headers.get('Cookie')))
                if self.headers.get('If-None-Match') == '"v1"':
                    self.send_response(304)
                    self.send_header('ETag', '"v1"')
                    self.end_headers()
                    return
                routes = {'/': (b'<!doctype html>status page', 'text/html; charset=utf-8'),
                          '/api/status': (json.dumps({'host': self.headers.get('Host')}).encode(), 'application/json')}
                if self.path not in routes:
                    self.send_error(404)
                    return
                body, content_type = routes[self.path]
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('ETag', '"v1"')
                self.send_header('Content-Security-Policy', "default-src 'none'; receiver")
                self.send_header('Set-Cookie', 'never=relayed')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(body)

            do_HEAD = do_GET

        upstream = HTTPServer(('127.0.0.1', 0), Receiver)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream.shutdown)
        return upstream, seen

    def test_port_80_relays_the_receiver_only_after_setup_completes(self):
        upstream, seen = self.receiver()
        probe = types.SimpleNamespace(available=lambda: True, port=upstream.server_port)
        server = self.server(probe)
        # Running, failed or interrupted setup keeps the setup page even when
        # the receiver answers.
        for state in ({}, {'state': 'failed', 'phase': None, 'exitCode': 1}, {'bootId': 'previous-boot'}):
            self.read(**state)
            self.assertIn(b'First-boot setup', self.request(server, '/')[2])
            self.assertEqual(self.request(server, '/api/status')[0], 404)
        self.assertEqual(seen, [])
        self.read(state='complete', phase='done', exitCode=0)
        code, headers, body = self.request(server, '/', headers={'Host': 'wavekit-pi.local', 'Cookie': 'x=1'})
        self.assertEqual((code, body), (200, b'<!doctype html>status page'))
        self.assertIn('receiver', headers['Content-Security-Policy'])
        self.assertNotIn('Set-Cookie', headers)
        self.assertEqual(seen[-1], ('GET', '/', 'wavekit-pi.local', None))
        # The receiver names its IQ endpoint after the address the browser used.
        body = self.request(server, '/api/status', headers={'Host': 'wavekit-pi.local'})[2]
        self.assertEqual(json.loads(body), {'host': 'wavekit-pi.local'})
        self.assertEqual(self.request(server, '/', headers={'If-None-Match': '"v1"'})[0], 304)
        self.assertEqual(self.request(server, '/', method='HEAD')[2], b'')
        # Setup state stays local, and so do setup-page files the receiver lacks.
        self.assertEqual(json.loads(self.request(server, '/api/setup')[2])['state'], 'complete')
        self.assertEqual(self.request(server, '/boot.js')[0], 200)
        self.assertEqual(self.request(server, '/api/status', method='POST')[0], 501)

    def test_port_80_falls_back_to_the_setup_page_when_the_receiver_stops(self):
        upstream, _ = self.receiver()
        port = upstream.server_port
        upstream.shutdown()
        upstream.server_close()
        server = self.server(types.SimpleNamespace(available=lambda: True, port=port))
        self.read(state='complete', phase='done', exitCode=0)
        code, _, body = self.request(server, '/')
        self.assertEqual(code, 200)
        self.assertIn(b'First-boot setup', body)
        self.assertEqual(self.request(server, '/api/host')[0], 404)

    def test_receiver_probe_checks_a_real_html_page_and_caches_bounded_requests(self):
        server = self.server()
        probe = boot_status.ReceiverProbe(server.server_port)
        self.assertTrue(probe.available())
        with patch.object(boot_status.http.client, 'HTTPConnection', side_effect=AssertionError('unexpected duplicate probe')):
            self.assertTrue(probe.available())
        response = types.SimpleNamespace(status=200, getheader=lambda *_: 'application/json')
        connection = types.SimpleNamespace(request=lambda *_: None, getresponse=lambda: response, close=lambda: None)
        probe.checked = float('-inf')
        with patch.object(boot_status.http.client, 'HTTPConnection', return_value=connection):
            self.assertFalse(probe.available())

    def test_image_support_is_present_and_service_has_no_setup_dependency(self):
        script_dir = ROOT / 'packages/sdr-host/scripts'
        for name in builder.IMAGE_SUPPORT:
            self.assertTrue((script_dir / name).is_file())
        for name in builder.BOOT_ASSETS:
            self.assertTrue((script_dir.parent / 'ui' / name).is_file())
        unit = (script_dir / 'wavekit-boot-status.service').read_text()
        self.assertIn('DynamicUser=yes', unit)
        self.assertIn('WantedBy=multi-user.target', unit)
        for dependency in ('cloud-final', 'network-online', 'docker.service'):
            self.assertNotIn(dependency, unit)
        policy = (script_dir / 'wavekit-wifi-powersave.conf').read_text()
        self.assertIn('[connection]\nwifi.powersave=2', policy)



class BootReportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wavekit-boot-report-')
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        (self.root / 'boot_id').write_text('boot-b\n')
        (self.root / 'bootstatus').write_text('0\n')

    def runner(self, journal, throttled='throttled=0x50000\n'):
        def run(command):
            if command[0] == 'vcgencmd':
                return throttled
            self.assertIn('-1', command)  # Only the previous boot is read.
            return journal
        return run

    def entries(self, *extra):
        rows = [{'__REALTIME_TIMESTAMP': '1791547200000000', '_PID': '812', 'MESSAGE': 'fixture-private'}, *extra]
        return ''.join(json.dumps(row) + '\n' for row in rows)

    def report(self, runner):
        return boot_report.report(runner, self.root / 'boot_id', self.root / 'missing', self.root / 'bootstatus')

    def test_tells_a_requested_shutdown_from_a_power_loss_or_crash(self):
        clean = self.entries({'__REALTIME_TIMESTAMP': '1791547260000000', '_PID': '1', 'UNIT': 'shutdown.target'})
        record = self.report(self.runner(clean))
        self.assertEqual(record['previous'], {'lastEntryAt': '2026-10-09T12:01:00+00:00', 'cleanShutdown': True})
        self.assertEqual(record['bootId'], 'boot-b')
        record = self.report(self.runner(self.entries()))
        self.assertEqual(record['previous'], {'lastEntryAt': '2026-10-09T12:00:00+00:00', 'cleanShutdown': False})
        self.assertNotIn('fixture-private', json.dumps(record))
        # Firmware bit 16: under-voltage since power-on; bit 18: throttled.
        self.assertEqual((record['undervoltageSinceBoot'], record['throttledSinceBoot']), (True, True))
        self.assertIsNone(record['watchdogReset'])

    def test_unreadable_facts_stay_unknown(self):
        record = self.report(lambda command: None)
        self.assertIsNone(record['previous'])
        self.assertIsNone(record['undervoltageSinceBoot'])
        (self.root / 'bootstatus').write_text('32\n')
        self.assertTrue(self.report(self.runner('not json')).get('watchdogReset'))
        self.assertIsNone(self.report(self.runner('not json'))['previous'])

    def test_writes_a_world_readable_record_atomically(self):
        status = self.root / 'status'
        boot_report.write({'schema': 1}, status)
        self.assertEqual(json.loads((status / 'last-boot.json').read_text()), {'schema': 1})
        self.assertEqual((status / 'last-boot.json').stat().st_mode & 0o777, 0o644)
        self.assertEqual(sorted(path.name for path in status.iterdir()), ['last-boot.json'])

    def test_image_keeps_a_capped_persistent_journal(self):
        conf = (ROOT / 'packages/sdr-host/scripts/wavekit-journald.conf').read_text()
        for line in ('Storage=persistent', 'SystemMaxUse=48M', 'SystemMaxFileSize=8M', 'SystemKeepFree=256M'):
            self.assertIn(line + '\n', conf)
        # Sorts after Raspberry Pi OS's own journald drop-ins, so it wins.
        self.assertEqual(builder.IMAGE_SUPPORT['wavekit-journald.conf'], '/etc/systemd/journald.conf.d/90-wavekit.conf')
        unit = (ROOT / 'packages/sdr-host/scripts/wavekit-boot-report.service').read_text()
        self.assertIn('After=systemd-journald.service systemd-journal-flush.service', unit)
        self.assertIn('WantedBy=multi-user.target', unit)

if __name__ == '__main__':
    unittest.main()
