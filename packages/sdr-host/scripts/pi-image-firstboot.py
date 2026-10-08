#!/usr/bin/python3
"""Activate the image payload after Imager's cloud-init customization."""
import datetime
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


def main():
    if os.geteuid() != 0:
        print('WaveKit firstboot must run as root', file=sys.stderr)
        return 1
    STATE.mkdir(parents=True, exist_ok=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    boot = next((path for path in BOOT_PATHS if (path / 'config.txt').is_file()), None)
    with LOG.open('a', buffering=1) as log:
        def status(value):
            if boot:
                timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
                (boot / 'wavekit-setup.status').write_text(f'{timestamp} {value}\n')

        def publish_log():
            log.flush()
            if boot:
                shutil.copyfile(LOG, boot / 'wavekit-setup.log')

        try:
            if (STATE / 'firstboot.done').is_file():
                status('complete')
                publish_log()
                return 0
            status('running')
            print('Starting WaveKit firstboot', file=log)
            # This runs from its own service, never from cloud-final runcmd.
            subprocess.run(['cloud-init', 'status', '--wait'], check=True, stdout=log, stderr=log)
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
            subprocess.run(['bash', './setup.sh', '--target-user', account.pw_name],
                           cwd=working, check=True, stdout=log, stderr=log)
            # Publish as the account itself so concurrent home-directory edits
            # cannot turn a root copy/chown into an arbitrary privileged write.
            install.chmod(0o755)
            for command in [
                ['runuser', '-u', account.pw_name, '--', 'mkdir', '-p', str(destination)],
                ['runuser', '-u', account.pw_name, '--', 'cp', '-a', '--no-preserve=ownership', str(working) + '/.', str(destination)],
            ]:
                subprocess.run(command, check=True, stdout=log, stderr=log)
            print('WaveKit setup complete; verify dongle streaming separately', file=log)
            status('complete')
            publish_log()
            (STATE / 'firstboot.done').touch()
            return 0
        except Exception as error:
            # Do not stringify arbitrary YAML/parser errors or configurations;
            # those may include passwords. Setup output remains in the log.
            code = error.returncode if isinstance(error, subprocess.CalledProcessError) else 1
            print(f'WaveKit firstboot failed ({type(error).__name__}, exit {code}); retry with systemctl restart wavekit-firstboot', file=log)
            try:
                status('failed')
                publish_log()
            except OSError:
                print('Could not publish boot diagnostics; see system log', file=log)
            return code if 0 < code < 256 else 1


if __name__ == '__main__':
    sys.exit(main())
