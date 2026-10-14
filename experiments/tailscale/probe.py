"""Fixed, credential-free checks of the deployed container's network capabilities."""
import fcntl
import json
import os
import pathlib
import stat
import struct
import subprocess
import time


def command(*args, timeout=15):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return {"exit_code": p.returncode, "stdout": p.stdout[-6000:], "stderr": p.stderr[-6000:]}
    except subprocess.TimeoutExpired:
        return {"error": "timeout"}


result = {"kernel": os.uname().release, "uid": os.getuid()}
result["capabilities"] = [line for line in pathlib.Path('/proc/self/status').read_text().splitlines() if line.startswith('Cap')]
result["tailscale_version"] = command('tailscale', 'version')
result["tun_existed"] = pathlib.Path('/dev/net/tun').exists()
fd = None
try:
    if not result["tun_existed"]:
        pathlib.Path('/dev/net').mkdir(exist_ok=True)
        os.mknod('/dev/net/tun', stat.S_IFCHR | 0o600, os.makedev(10, 200))
    fd = os.open('/dev/net/tun', os.O_RDWR)
    # Linux TUNSETIFF with IFF_TUN | IFF_NO_PI. Closing fd removes this test interface.
    fcntl.ioctl(fd, 0x400454ca, struct.pack('16sH', b'cf-tun-probe', 0x0001 | 0x1000))
    result['tun_ioctl'] = {'success': True}
    result['link_up'] = command('ip', 'link', 'set', 'cf-tun-probe', 'up')
    result['assign_address'] = command('ip', 'address', 'add', '192.0.2.1/32', 'dev', 'cf-tun-probe')
    result['add_route'] = command('ip', 'route', 'add', '192.0.2.2/32', 'dev', 'cf-tun-probe')
except OSError as e:
    result['tun_ioctl'] = {'success': False, 'errno': e.errno, 'error': str(e)}
finally:
    if fd is not None:
        os.close(fd)

result['netfilter'] = command('iptables', '-S')
try:
    # Check the normal resolver configuration is writable without changing its contents.
    p = pathlib.Path('/etc/resolv.conf')
    original = p.read_bytes()
    p.write_bytes(original)
    result['resolver_writable'] = True
except OSError as e:
    result['resolver_writable'] = {'errno': e.errno, 'error': str(e)}
result['control_plane_https'] = command('curl', '--connect-timeout', '10', '--max-time', '15', '-sS', '-o', '/dev/null', '-w', '%{http_code}', 'https://controlplane.tailscale.com/')

with open('/tmp/tailscaled-probe.log', 'w') as log:
    daemon = subprocess.Popen(['tailscaled', '--tun=tailscale0', '--state=mem:', '--socket=/tmp/tailscale-probe.sock'], stdout=log, stderr=log)
    time.sleep(5)
    result['kernel_daemon_exit_code'] = daemon.poll()
    result['tailscale0'] = command('ip', '-j', 'link', 'show', 'tailscale0')
    status = command('tailscale', '--socket=/tmp/tailscale-probe.sock', 'status', '--json')
    try:
        result['backend_state'] = json.loads(status['stdout']).get('BackendState')
    except (KeyError, ValueError):
        result['status_error'] = status
    if daemon.poll() is None:
        daemon.terminate()
        try:
            daemon.wait(timeout=5)
        except subprocess.TimeoutExpired:
            daemon.kill()
            daemon.wait()
result['daemon_log'] = pathlib.Path('/tmp/tailscaled-probe.log').read_text()[-12000:]
print(json.dumps(result))
