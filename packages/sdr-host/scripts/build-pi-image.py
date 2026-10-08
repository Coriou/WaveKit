#!/usr/bin/env python3
"""Build a flashable WaveKit image by editing regular files, never block devices.

Requires xz and e2fsprogs (debugfs/e2fsck); no mounts, Docker or root required.
--base-sha256 is the trusted SHA256 of the DECOMPRESSED stock image.
"""
import argparse
import datetime
import hashlib
import json
import os
import posixpath
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import tempfile
import tarfile

PAYLOAD = ('IMAGE.txt', 'wavekit-sdr-host-image.tar.gz', 'docker-compose.yml',
           'install-docker.sh', 'setup.sh', '.env.example')
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[2]
SECTOR = 512
BOOT_ASSETS = ('boot.html', 'boot.js', 'boot.css', 'app.css',
               'fonts/barlow-500.woff2', 'fonts/barlow-600.woff2',
               'fonts/barlow-semi-condensed-600.woff2', 'fonts/OFL.txt')
IMAGE_SUPPORT = {
    'pi-boot-status.py': '/usr/local/lib/wavekit/boot-status.py',
    'wavekit-boot-status.service': '/etc/systemd/system/wavekit-boot-status.service',
    'wavekit-wifi-powersave.conf': '/etc/NetworkManager/conf.d/90-wavekit-wifi-powersave.conf',
}


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def regular(path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f'Expected a regular file: {path.name}')


def verify_bundle(bundle):
    for name in (*PAYLOAD, 'SHA256SUMS'):
        regular(bundle / name)
    expected = {}
    for line in (bundle / 'SHA256SUMS').read_text().splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  (.+)', line)
        if not match or match[2] not in PAYLOAD or match[2] in expected:
            raise ValueError('Invalid bundle checksum manifest')
        expected[match[2]] = match[1]
    for name in PAYLOAD:
        if expected.get(name) != digest(bundle / name):
            raise ValueError(f'Bundle checksum mismatch: {name}')
    image = (bundle / 'IMAGE.txt').read_text().strip()
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._/:-]*', image):
        raise ValueError('Bundle image tag is invalid')
    with tarfile.open(bundle / 'wavekit-sdr-host-image.tar.gz', 'r:gz') as archive:
        def json_member(name):
            member = archive.getmember(name)
            if not member.isfile() or member.size > 1024 * 1024:
                raise ValueError('Invalid Docker archive metadata')
            with archive.extractfile(member) as stream:
                return json.load(stream)
        manifest = json_member('manifest.json')
        if not isinstance(manifest, list) or len(manifest) != 1 or not isinstance(manifest[0], dict) or image not in manifest[0].get('RepoTags', []):
            raise ValueError('Docker archive must contain the selected image only')
        config = json_member(manifest[0]['Config'])
        if config.get('os') != 'linux' or config.get('architecture') != 'arm64':
            raise ValueError('Docker archive must contain a Linux ARM64 image')
    return sum((bundle / name).stat().st_size for name in (*PAYLOAD, 'SHA256SUMS'))


def partitions(image):
    regular(image)
    size = image.stat().st_size
    with image.open('rb') as stream:
        mbr = stream.read(SECTOR)
    if len(mbr) != SECTOR or mbr[510:512] != b'\x55\xaa':
        raise ValueError('Base does not have a valid MBR')
    entries = []
    for index in range(4):
        entry = mbr[446 + index * 16:462 + index * 16]
        kind, start, sectors = entry[4], *struct.unpack_from('<II', entry, 8)
        if not kind and not start and not sectors:
            continue
        if kind not in (0x0b, 0x0c, 0x83) or not start or not sectors:
            raise ValueError('Unsupported partition layout')
        begin, end = start * SECTOR, (start + sectors) * SECTOR
        if begin < SECTOR or end > size:
            raise ValueError('Partition extends outside base image')
        entries.append((kind, begin, end))
    ordered = sorted(entries, key=lambda entry: entry[1])
    if len(ordered) != 2 or ordered[0][0] not in (0x0b, 0x0c) or ordered[1][0] != 0x83:
        raise ValueError('Expected Raspberry Pi FAT boot and Linux root partitions')
    if ordered[0][2] > ordered[1][1]:
        raise ValueError('Overlapping partitions')
    return ordered[1][1:]


def extract_partition(image, output, begin, end):
    with image.open('rb') as source, output.open('wb') as target:
        source.seek(begin)
        remaining = end - begin
        while remaining:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk:
                raise ValueError('Truncated root partition')
            target.write(chunk)
            remaining -= len(chunk)


def ext4_free_bytes(root):
    with root.open('rb') as stream:
        stream.seek(1024)
        sb = stream.read(1024)
    if len(sb) != 1024 or sb[56:58] != b'\x53\xef':
        raise ValueError('Linux root partition is not ext4')
    incompat = struct.unpack_from('<I', sb, 96)[0]
    if not incompat & 0x40:  # EXT4_FEATURE_INCOMPAT_EXTENTS
        raise ValueError('Expected an ext4 filesystem with extents')
    blocks = struct.unpack_from('<I', sb, 4)[0]
    free = struct.unpack_from('<I', sb, 12)[0]
    if incompat & 0x80:  # 64-bit block counters
        blocks |= struct.unpack_from('<I', sb, 336)[0] << 32
        free |= struct.unpack_from('<I', sb, 344)[0] << 32
    block_shift = struct.unpack_from('<I', sb, 24)[0]
    if block_shift > 6:
        raise ValueError('Unsupported ext4 block size')
    block_size = 1024 << block_shift
    if block_size not in (1024, 2048, 4096, 8192, 16384, 32768, 65536):
        raise ValueError('Unsupported ext4 block size')
    if blocks * block_size > root.stat().st_size or free > blocks:
        raise ValueError('Invalid ext4 size counters')
    return free * block_size


def quote(value):
    value = str(value)
    if any(character in value for character in ('\n', '\r', '\0')):
        raise ValueError('Unsafe debugfs path')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


class Filesystem:
    def __init__(self, root, debugfs, work):
        self.root, self.debugfs, self.work = root, debugfs, work

    def command(self, text, write=False):
        command = [self.debugfs]
        if write:
            command.append('-w')
        result = subprocess.run([*command, '-R', text, str(self.root)],
                                text=True, capture_output=True, check=True, timeout=120)
        return result.stdout + result.stderr

    def exists(self, path):
        return bool(re.search(r'Inode:\s+\d+', self.command(f'stat {quote(path)}')))

    def read(self, path):
        for _ in range(16):
            metadata = self.command(f'stat {quote(path)}')
            if 'Type: symlink' not in metadata:
                break
            match = re.search(r'Fast link dest: "([^"]+)"', metadata)
            if not match:
                raise ValueError(f'Unsupported stock symlink: {path}')
            path = posixpath.normpath(posixpath.join(posixpath.dirname(path), match[1]))
        else:
            raise ValueError('Stock symlink resolution limit exceeded')
        dumped = self.work / 'inspect-file'
        dumped.unlink(missing_ok=True)
        self.command(f'dump {quote(path)} {quote(dumped)}')
        if not dumped.is_file():
            raise ValueError(f'Required stock file missing: {path}')
        return dumped.read_bytes()

    def directory(self, path):
        current = ''
        for segment in Path(path).parts[1:]:
            current += '/' + segment
            if not self.exists(current):
                self.command(f'mkdir {quote(current)}', write=True)
            metadata = self.command(f'stat {quote(current)}')
            if 'Type: directory' not in metadata:
                raise ValueError(f'Cannot create image directory: {current}')
            if not re.search(r'User:\s+0\s+Group:\s+0', metadata):
                raise ValueError(f'Image installer directory must be root-owned: {current}')

    def insert(self, source, target, mode):
        self.directory(str(Path(target).parent))
        if self.exists(target):
            raise ValueError(f'Image already contains WaveKit payload: {target}')
        self.command(f'write {quote(source)} {quote(target)}', write=True)
        for field, value in [('uid', '0'), ('gid', '0'), ('mode', f'0{mode:o}')]:
            self.command(f'set_inode_field {quote(target)} {field} {value}', write=True)
        # debugfs may return success when an individual operation failed.
        dumped = self.work / 'verify-file'
        dumped.unlink(missing_ok=True)
        self.command(f'dump {quote(target)} {quote(dumped)}')
        if not dumped.is_file() or digest(dumped) != digest(source):
            raise ValueError(f'Injected file verification failed: {target}')
        metadata = self.command(f'stat {quote(target)}')
        if not re.search(r'User:\s+0\s+Group:\s+0', metadata):
            raise ValueError(f'Injected ownership verification failed: {target}')
        if not re.search(rf'Mode:\s+0*{mode & 0o7777:o}\b', metadata):
            raise ValueError(f'Injected permissions verification failed: {target}')


def validate_stock(fs):
    release = fs.read('/etc/os-release').decode()
    if not re.search(r'^ID=(?:"?)(?:debian|raspbian)(?:"?)$', release, re.M):
        raise ValueError('Base is not Raspberry Pi OS Debian')
    fs.read('/etc/rpi-issue')
    packages = fs.read('/var/lib/dpkg/status').decode()
    if not re.search(r'^Architecture: arm64$', packages, re.M):
        raise ValueError('Base does not contain an ARM64 userland')
    if not fs.exists('/usr/bin/cloud-init') or not fs.exists('/usr/bin/python3'):
        raise ValueError('Base requires cloud-init and Python 3')
    if not fs.exists('/usr/sbin/NetworkManager'):
        raise ValueError('Base requires NetworkManager for the image Wi-Fi policy')
    unit_path = '/usr/lib/systemd/system/cloud-final.service'
    if not fs.exists(unit_path):
        unit_path = '/lib/systemd/system/cloud-final.service'
    final = fs.read(unit_path).decode()
    target_path = '/usr/lib/systemd/system/cloud-init.target'
    if not fs.exists(target_path):
        target_path = '/lib/systemd/system/cloud-init.target'
    target = fs.read(target_path).decode()
    if 'cloud-init.target' not in final or not fs.exists('/etc/systemd/system/cloud-init.target.wants/cloud-final.service'):
        raise ValueError('Unsupported cloud-init systemd graph')
    if re.search(r'^Before=.*\bcloud-final.service\b', target, re.M):
        raise ValueError('cloud-init target ordering would create a cycle')
    for line in fs.read('/etc/passwd').decode().splitlines():
        fields = line.split(':')
        if len(fields) != 7:
            raise ValueError('Invalid stock passwd data')
        if 1000 <= int(fields[2]) < 65534:
            # Official Raspberry Pi OS includes a locked pi placeholder for
            # cloud-init/userconfig. Permit that stock account only when it has
            # no usable password or SSH authorization; never log shadow data.
            shadow = [row.split(':') for row in fs.read('/etc/shadow').decode().splitlines()]
            passwords = [row[1] for row in shadow if len(row) > 1 and row[0] == fields[0]]
            locked = len(passwords) == 1 and passwords[0].startswith(('!', '*'))
            authorized = fs.exists(posixpath.join(fields[5], '.ssh/authorized_keys'))
            if fields[0] != 'pi' or int(fields[2]) != 1000 or not locked or authorized:
                raise ValueError('Base contains a baked-in authenticated normal account')
    for name in ('ssh_host_rsa_key', 'ssh_host_ecdsa_key', 'ssh_host_ed25519_key'):
        if fs.exists('/etc/ssh/' + name):
            raise ValueError('Base contains baked-in SSH host identities')
    if fs.exists('/var/lib/cloud/instance') or fs.exists('/var/lib/wavekit/firstboot.done'):
        raise ValueError('Base was already initialized')
    if fs.exists('/etc/machine-id') and fs.read('/etc/machine-id').strip() not in (b'', b'uninitialized'):
        raise ValueError('Base contains a baked-in machine identity')


def tool(name, directory):
    candidate = directory / name if directory else None
    found = str(candidate) if candidate and candidate.is_file() else shutil.which(name)
    if not found:
        for prefix in ('/usr/local', '/opt/homebrew'):
            homebrew = Path(prefix) / 'opt/e2fsprogs/sbin' / name
            if homebrew.is_file():
                found = str(homebrew)
                break
    if not found:
        raise ValueError(f'Required tool unavailable: {name}')
    return found


def check_clean(root, e2fsck):
    result = subprocess.run([e2fsck, '-f', '-n', str(root)], capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise ValueError('Image filesystem is not clean; refusing repair or publication')


def enable_service(fs, target, service):
    wants = '/etc/systemd/system/' + target + '.wants'
    fs.directory(wants)
    link = wants + '/' + service
    if fs.exists(link):
        raise ValueError('WaveKit service is already enabled')
    fs.command(f'symlink {quote(link)} ../{service}', write=True)
    if f'Fast link dest: "../{service}"' not in fs.command(f'stat {quote(link)}'):
        raise ValueError('Failed to enable WaveKit service')


def select_default(output, repo_root=REPO_ROOT):
    """Promote a completed local build without replacing older candidate files."""
    output, workspace_output = output.resolve(), repo_root.resolve() / 'output'
    if not output.is_relative_to(workspace_output):
        return
    regular(output / 'os-list.json')
    regular(output / 'BUILD.json')
    regular(output / 'wavekit-sdr-host.img.xz')
    pointer = workspace_output / 'pi-image-current.json'
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=workspace_output,
                                         prefix='.pi-image-current-', delete=False) as stream:
            temporary = Path(stream.name)
            json.dump({'manifest': os.path.relpath(output / 'os-list.json', workspace_output)}, stream)
            stream.write('\n')
        os.replace(temporary, pointer)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def build(args):
    base, bundle, output = args.base.resolve(), args.bundle.resolve(), args.output.resolve()
    regular(base)
    if not re.fullmatch(r'[a-fA-F0-9]{64}', args.base_sha256):
        raise ValueError('--base-sha256 requires the trusted decompressed image SHA256')
    payload_bytes = verify_bundle(bundle)
    debugfs, e2fsck, xz = (tool(name, args.e2fsprogs if name != 'xz' else None)
                           for name in ('debugfs', 'e2fsck', 'xz'))
    output.mkdir(parents=True, exist_ok=True)
    image_target = output / 'wavekit-sdr-host.img.xz'
    if image_target == base:
        raise ValueError('Output must not overwrite the base image')
    with tempfile.TemporaryDirectory(prefix='.wavekit-image-', dir=output) as temporary:
        work = Path(temporary)
        # Snapshot inputs once: later repository edits cannot change either
        # injected bytes or the provenance recorded after compression.
        bundle_snapshot = work / 'bundle'
        bundle_snapshot.mkdir()
        for name in (*PAYLOAD, 'SHA256SUMS'):
            shutil.copyfile(bundle / name, bundle_snapshot / name)
        payload_bytes = verify_bundle(bundle_snapshot)
        firstboot_source = work / 'firstboot.py'
        service_source = work / 'firstboot.service'
        shutil.copyfile(SCRIPT_DIR / 'pi-image-firstboot.py', firstboot_source)
        shutil.copyfile(SCRIPT_DIR / 'wavekit-firstboot.service', service_source)
        support = work / 'support'
        support.mkdir()
        for name in IMAGE_SUPPORT:
            shutil.copyfile(SCRIPT_DIR / name, support / name)
        assets = work / 'boot-assets'
        for name in BOOT_ASSETS:
            destination = assets / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SCRIPT_DIR.parent / 'ui' / name, destination)
        image = work / 'wavekit.img'
        print('[wavekit] Decompressing and verifying pinned stock image', flush=True)
        with image.open('wb') as target:
            subprocess.run([xz, '--decompress', '--stdout', str(base)], stdout=target, check=True)
        if digest(image) != args.base_sha256.lower():
            raise ValueError('Base image SHA256 does not match trusted decompressed hash')
        begin, end = partitions(image)
        root = work / 'root.ext4'
        extract_partition(image, root, begin, end)
        check_clean(root, e2fsck)
        if ext4_free_bytes(root) < payload_bytes + 64 * 1024 * 1024:
            raise ValueError('Stock root partition has insufficient free space for bundle')
        fs = Filesystem(root, debugfs, work)
        validate_stock(fs)
        print('[wavekit] Embedding verified bundle and firstboot service', flush=True)
        for name in (*PAYLOAD, 'SHA256SUMS'):
            mode = 0o100755 if name in ('setup.sh', 'install-docker.sh') else 0o100644
            fs.insert(bundle_snapshot / name, '/opt/wavekit/pi-bundle/' + name, mode)
        fs.insert(firstboot_source, '/usr/local/sbin/wavekit-firstboot', 0o100755)
        fs.insert(service_source, '/etc/systemd/system/wavekit-firstboot.service', 0o100644)
        for name, target in IMAGE_SUPPORT.items():
            fs.insert(support / name, target, 0o100644)
        for name in BOOT_ASSETS:
            fs.insert(assets / name, '/usr/local/share/wavekit/boot-status/' + name, 0o100644)
        fs.directory('/var/lib/wavekit/status')
        enable_service(fs, 'cloud-init.target', 'wavekit-firstboot.service')
        enable_service(fs, 'multi-user.target', 'wavekit-boot-status.service')
        check_clean(root, e2fsck)
        with image.open('r+b') as target, root.open('rb') as source:
            target.seek(begin)
            shutil.copyfileobj(source, target, 1024 * 1024)
        image_size, image_hash = image.stat().st_size, digest(image)
        compressed = work / image_target.name
        print('[wavekit] Compressing flashable image', flush=True)
        with compressed.open('wb') as target:
            subprocess.run([xz, '-T2', '-3', '--stdout', str(image)], stdout=target, check=True)
        manifest = {'imager': {'devices': [
            {'name': f'Raspberry Pi {model}', 'description': f'Raspberry Pi {model} family',
             'tags': [f'pi{model}-64bit', f'pi{model}-32bit'], 'matching_type': 'inclusive'}
            for model in (3, 4, 5)
        ]}, 'os_list': [{
            'name': 'WaveKit SDR Host — Raspberry Pi OS Lite 64-bit',
            'description': 'Configure Wi-Fi, user and SSH in Imager; WaveKit installs automatically at first boot. Internet required for Docker packages.',
            'icon': 'https://downloads.raspberrypi.com/raspios_armhf/Raspberry_Pi_OS_(32-bit).png',
            'url': image_target.as_uri(), 'extract_size': image_size,
            'extract_sha256': image_hash, 'image_download_size': compressed.stat().st_size,
            'release_date': datetime.date.today().isoformat(), 'init_format': 'cloudinit-rpi',
            'devices': ['pi5-64bit', 'pi4-64bit', 'pi3-64bit'],
        }]}
        manifest_tmp = work / 'os-list.json'
        manifest_tmp.write_text(json.dumps(manifest, indent=2) + '\n')
        provenance_tmp = work / 'BUILD.json'
        provenance_tmp.write_text(json.dumps({
            'base_extract_sha256': args.base_sha256.lower(), 'bundle_sha256sums_sha256': digest(bundle_snapshot / 'SHA256SUMS'),
            'firstboot_sha256': digest(firstboot_source),
            'service_sha256': digest(service_source),
            'image_support_sha256': {name: digest(support / name) for name in IMAGE_SUPPORT},
            'boot_assets_sha256': {name: digest(assets / name) for name in BOOT_ASSETS},
            'extract_sha256': image_hash, 'compressed_sha256': digest(compressed),
        }, indent=2) + '\n')
        # All validation completes before publishing. Each replacement is atomic;
        # the manifest is last so a interrupted build cannot advertise a partial file.
        os.replace(compressed, image_target)
        os.replace(provenance_tmp, output / 'BUILD.json')
        os.replace(manifest_tmp, output / 'os-list.json')
        select_default(output)
    print(f'[wavekit] Flashable image ready: {image_target}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True, type=Path, help='Pinned stock .img.xz file')
    parser.add_argument('--base-sha256', required=True, help='Trusted SHA256 of the decompressed stock image')
    parser.add_argument('--bundle', type=Path, default=REPO_ROOT / 'output/pi-bundle')
    parser.add_argument('--output', type=Path, default=REPO_ROOT / 'output/pi-image')
    parser.add_argument('--e2fsprogs', type=Path, help='Directory containing debugfs and e2fsck')
    args = parser.parse_args()
    try:
        build(args)
    except (ValueError, OSError, KeyError, tarfile.TarError, subprocess.SubprocessError) as error:
        parser.exit(1, f'[wavekit] Image build failed: {error}\n')


if __name__ == '__main__':
    main()
