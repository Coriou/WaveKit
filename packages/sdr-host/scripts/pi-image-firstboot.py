#!/usr/bin/python3
"""Activate the image payload after Imager's cloud-init customization."""
import datetime
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys

BUNDLE = Path('/opt/wavekit/pi-bundle')
STATE = Path('/var/lib/wavekit')
LOG = Path('/var/log/wavekit-firstboot.log')
BOOT_ID = Path('/proc/sys/kernel/random/boot_id')
BOOT_PATHS = (Path('/boot/firmware'), Path('/boot'))
CONFIG = Path('/var/lib/cloud/instance/cloud-config.txt')


def configured_user(config):
    """Resolve only a user declared by cloud-init, never guess UID 1000."""
    candidates = set()
    users = config.get('users', [])
    if not isinstance(users, list):
        raise ValueError('cloud-init users must be a list')
    for user in users + [config.get('user')]:
        if user == 'default':
            user = config.get('system_info', {}).get('default_user', {})
        if isinstance(user, str):
            candidates.add(user)
        elif isinstance(user, dict) and not user.get('system'):
            name = user.get('name')
            if isinstance(name, str):
                candidates.add(name)
    candidates.discard('root')
    candidates.discard('default')
    if len(candidates) != 1:
        raise ValueError('Configure exactly one normal account in Imager')
    name = candidates.pop()
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', name):
        raise ValueError('Invalid configured normal account name')
    account = pwd.getpwnam(name)
    if account.pw_uid == 0:
        raise ValueError('Configured account must not be root')
    home = Path(account.pw_dir)
    if not home.is_absolute() or home in (Path('/'), Path('/root')) or not home.is_dir():
        raise ValueError('Configured account has an unsuitable home')
    return account


# Raspberry Pi OS 2026-10-06 + Imager 2.0.11.1 requests this absent module.
# The observed run completes account/network setup; allow only this exact
# warning, never arbitrary cloud-init exit-2 results or unfinished runs.
KNOWN_CLOUD_WARNING = (
    "Could not find module named cc_netplan_nm_patch "
    "(searched ['cc_netplan_nm_patch', 'cloudinit.config.cc_netplan_nm_patch'])"
)


def wait_for_cloud_init(log):
    command = ['cloud-init', 'status', '--wait', '--format', 'json']
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode not in (0, 2):
        raise subprocess.CalledProcessError(result.returncode, command)
    report = json.loads(result.stdout)
    if not isinstance(report, dict) or report.get('status') != 'done':
        raise ValueError('Cloud-init did not finish')
    if report.get('extended_status') not in ('done', 'degraded done'):
        raise ValueError('Cloud-init did not finish successfully')
    warning_seen = False
    # Check both aggregate and per-stage diagnostics without copying their
    # arbitrary text (which can include credentials) into the public boot log.
    for section in [report] + [report[key] for key in
                              ('init-local', 'init', 'modules-config', 'modules-final')
                              if key in report]:
        if not isinstance(section, dict) or section.get('errors') != []:
            raise ValueError('Cloud-init reported errors')
        recoverable = section.get('recoverable_errors')
        if not isinstance(recoverable, dict):
            raise ValueError('Cloud-init diagnostics are missing')
        for level, messages in recoverable.items():
            if not isinstance(messages, list):
                raise ValueError('Cloud-init diagnostics are malformed')
            for message in messages:
                if level != 'WARNING' or message != KNOWN_CLOUD_WARNING:
                    raise ValueError('Cloud-init reported an unreviewed warning')
                warning_seen = True
    if result.returncode == 2 and not warning_seen:
        raise ValueError('Cloud-init exit 2 has no reviewed warning')
    if warning_seen:
        print('Cloud-init completed with reviewed missing cc_netplan_nm_patch warning; continuing', file=log)
    else:
        print('Cloud-init completed successfully', file=log)


def write_setup_status(state, phase, exit_code=None):
    """Publish sanitized progress for the receiver status page.

    Compose mounts only STATE/status, read-only. The record holds allowlisted
    fields: never messages, accounts, paths or configuration.
    """
    status_dir = STATE / 'status'
    try:
        boot_id = BOOT_ID.read_text().strip()[:64] or None
    except OSError:
        boot_id = None
    record = {
        'schema': 1,
        'state': state,
        'phase': phase,
        'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'bootId': boot_id,
        'exitCode': exit_code,
    }
    status_dir.mkdir(parents=True, exist_ok=True)
    status_dir.chmod(0o755)
    temporary = status_dir / '.setup.json.tmp'
    temporary.write_text(json.dumps(record) + '\n')
    temporary.chmod(0o644)
    # Atomic rename: readers never see a partial record.
    os.replace(temporary, status_dir / 'setup.json')


def main():
    if os.geteuid() != 0:
        print('WaveKit firstboot must run as root', file=sys.stderr)
        return 1
    STATE.mkdir(parents=True, exist_ok=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    boot = next((path for path in BOOT_PATHS if (path / 'config.txt').is_file()), None)
    with LOG.open('a', buffering=1) as log:
        def status(value, phase, exit_code=None):
            if boot:
                timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
                (boot / 'wavekit-setup.status').write_text(f'{timestamp} {value}\n')
            try:
                write_setup_status(value, phase, exit_code)
            except OSError:
                # The status page is optional; never fail setup over it.
                print('Could not publish status page record', file=log)

        def publish_log():
            log.flush()
            if boot:
                shutil.copyfile(LOG, boot / 'wavekit-setup.log')

        try:
            if (STATE / 'firstboot.done').is_file():
                status('complete', 'done')
                publish_log()
                return 0
            status('running', 'cloud-init')
            print('Starting WaveKit firstboot', file=log)
            # This runs from its own service, never from cloud-final runcmd.
            wait_for_cloud_init(log)
            import yaml  # Already required by Raspberry Pi OS cloud-init.
            config = yaml.safe_load(CONFIG.read_text())
            if not isinstance(config, dict):
                raise ValueError('cloud-init did not provide an account configuration')
            account = configured_user(config)
            if not (BUNDLE / 'setup.sh').is_file():
                raise ValueError('Embedded WaveKit bundle is missing')
            destination = Path(account.pw_dir) / 'wavekit-pi-bundle'
            if destination.is_symlink():
                raise ValueError('Bundle destination must not be a symlink')
            if destination.exists():
                # Existing user data may contain symlinks. Reject them rather
                # than letting an installer copy overwrite another location.
                if any(path.is_symlink() for path in destination.rglob('*')):
                    raise ValueError('Existing bundle contains symlinks; inspect it before retry')
            install = STATE / 'install'
            install.mkdir(mode=0o700, exist_ok=True)
            install.chmod(0o700)
            working = install / 'wavekit-pi-bundle'
            # Execute only root-controlled inputs. The eventual SSH account's
            # writable home is never the source of a root-executed installer.
            shutil.copytree(BUNDLE, working, dirs_exist_ok=True)
            status('running', 'install')
            subprocess.run(['bash', './setup.sh', '--target-user', account.pw_name],
                           cwd=working, check=True, stdout=log, stderr=log)
            # Publish as the account itself so concurrent home-directory edits
            # cannot turn a root copy/chown into an arbitrary privileged write.
            install.chmod(0o755)
            status('running', 'publish')
            for command in [
                ['runuser', '-u', account.pw_name, '--', 'mkdir', '-p', str(destination)],
                ['runuser', '-u', account.pw_name, '--', 'cp', '-a', '--no-preserve=ownership', str(working) + '/.', str(destination)],
            ]:
                subprocess.run(command, check=True, stdout=log, stderr=log)
            print('WaveKit setup complete; verify dongle streaming separately', file=log)
            status('complete', 'done', 0)
            publish_log()
            (STATE / 'firstboot.done').touch()
            return 0
        except Exception as error:
            # Do not stringify arbitrary YAML/parser errors or configurations;
            # those may include passwords. Setup output remains in the log.
            code = error.returncode if isinstance(error, subprocess.CalledProcessError) else 1
            print(f'WaveKit firstboot failed ({type(error).__name__}, exit {code}); retry with systemctl restart wavekit-firstboot', file=log)
            try:
                status('failed', None, code if 0 < code < 256 else 1)
                publish_log()
            except OSError:
                print('Could not publish boot diagnostics; see system log', file=log)
            return code if 0 < code < 256 else 1


if __name__ == '__main__':
    sys.exit(main())
