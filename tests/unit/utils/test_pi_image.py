"""File-only installer acceptance; all mutable paths live in temporary fixtures."""
import argparse
import hashlib
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


class ImageBuilderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wavekit-image-test-')
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

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


if __name__ == '__main__':
    unittest.main()
