"""Join a tailnet and query Postgres over verified TLS. Configuration arrives on stdin."""
import json
import os
import pathlib
import socket
import subprocess
import sys
import time
import uuid


def run(args, *, env=None, timeout=30):
    p = subprocess.run(args, env=env, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        # Commands can print connection strings, login URLs or server messages.
        # Keep those in the ephemeral container, not in Worker logs or the response.
        raise RuntimeError(f'{args[0]} exited {p.returncode}')
    return p.stdout


config = json.load(sys.stdin)
required = ('TS_AUTHKEY', 'PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD')
if any(not isinstance(config.get(k), str) or not config[k] for k in required):
    raise SystemExit('Missing required test configuration')
if any(c in config['PGHOST'] for c in ('=', ' ', '\n', '/')):
    raise SystemExit('PGHOST must be a hostname, not a connection string')
socket_path = '/run/tailscale/tailscaled.sock'
directory = pathlib.Path('/run/tailscale')
directory.mkdir(mode=0o700, exist_ok=True)
key_file = directory / 'authkey'
key_file.write_text(config['TS_AUTHKEY'])
key_file.chmod(0o600)
ts = ['tailscale', '--socket=' + socket_path]
result = {'passed': False, 'stage': 'start_kernel_daemon', 'proxy_used': False}
daemon = None
try:
    with open('/run/tailscale/daemon.log', 'w') as log:
        daemon = subprocess.Popen(['tailscaled', '--tun=tailscale0', '--state=mem:', '--socket=' + socket_path], stdout=log, stderr=log)
    deadline = time.monotonic() + 15
    while not pathlib.Path(socket_path).exists():
        if daemon.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError('Kernel tailscaled did not start')
        time.sleep(0.2)
    result['stage'] = 'join_tailnet'
    run(ts + ['up', '--auth-key=file:' + str(key_file), '--accept-dns=true', '--accept-routes=true', '--hostname=cf-tailscale-test-' + uuid.uuid4().hex[:8], '--timeout=45s'], timeout=50)
    key_file.unlink()
    status = json.loads(run(ts + ['status', '--json']))
    result['backend_state'] = status['BackendState']
    if result['backend_state'] != 'Running':
        raise RuntimeError('Tailnet is not running')
    result['stage'] = 'normal_resolver'
    # This is the application's normal libc resolver: no SOCKS resolver or hosts override.
    addresses = sorted({a[4][0] for a in socket.getaddrinfo(config['PGHOST'], int(config.get('PGPORT', '5432')), type=socket.SOCK_STREAM)})
    result['resolved_addresses'] = addresses
    result['stage'] = 'tailnet_routes'
    routes = [json.loads(run(['ip', '-j', 'route', 'get', address])) for address in addresses]
    if not addresses or any(route[0].get('dev') != 'tailscale0' for route in routes):
        raise RuntimeError('Database address does not route through tailscale0')
    result['stage'] = 'postgres_tls_query'
    env = {k: v for k, v in os.environ.items() if not k.upper().endswith('_PROXY') and not k.startswith('PG')}
    env.update({k: str(config[k]) for k in ('PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD')})
    env.update(PGPORT=str(config.get('PGPORT', '5432')), PGSSLMODE='verify-full', PGCONNECT_TIMEOUT='15', PGOPTIONS='-c statement_timeout=10000 -c default_transaction_read_only=on')
    if config.get('PGSSLROOTCERT_PEM'):
        ca = directory / 'postgres-ca.pem'
        ca.write_text(config['PGSSLROOTCERT_PEM'])
        env['PGSSLROOTCERT'] = str(ca)
    else:
        env['PGSSLROOTCERT'] = '/etc/ssl/certs/ca-certificates.crt'
    output = run(['psql', '-X', '-w', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1; SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid();'], env=env)
    result['postgres_result'] = output.strip().splitlines()
    if result['postgres_result'] != ['1', 't']:
        raise RuntimeError('Unexpected query result or PostgreSQL TLS is inactive')
    result.update(passed=True, stage='complete', sslmode='verify-full')
except (OSError, RuntimeError, subprocess.TimeoutExpired, KeyError, ValueError) as e:
    # Do not forward raw process output or secret-bearing configuration.
    result['error_type'] = type(e).__name__
finally:
    key_file.unlink(missing_ok=True)
    if daemon and daemon.poll() is None:
        try:
            run(ts + ['logout'], timeout=10)
        except Exception:
            pass
        # The Worker destroys the container, including the daemon, in its finally block.
print(json.dumps(result))
