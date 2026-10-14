"""Disposable TLS Postgres and split-DNS fixture, listening only on the tailnet."""
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def run(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, check=True, timeout=60, **kwargs).stdout


config = json.load(sys.stdin)
root = Path('/run/tailscale-fixture')
root.mkdir(mode=0o700, exist_ok=True)
key = root / 'authkey'
key.write_text(config['TS_AUTHKEY'])
key.chmod(0o600)
ts = ['tailscale', '--socket=/run/tailscale-fixture/tailscaled.sock']
stage = 'join_tailnet'
try:
    with (root / 'tailscaled.log').open('w') as log:
        subprocess.Popen(['tailscaled', '--tun=tailscale0', '--state=mem:', '--socket=/run/tailscale-fixture/tailscaled.sock'], stdout=log, stderr=log)
    for _ in range(100):
        if (root / 'tailscaled.sock').exists():
            break
        time.sleep(0.1)
    run(ts + ['up', '--auth-key=file:' + str(key), '--accept-dns=false', '--hostname=cf-postgres-fixture', '--timeout=45s'])
    key.unlink()
    address = run(ts + ['ip', '-4']).strip()
    ipaddress.IPv4Address(address)
    stage = 'postgres_setup'
    data = Path('/var/lib/postgresql/test')
    data.mkdir(mode=0o700)
    password_file = Path('/var/lib/postgresql/test-password')
    password_file.write_text(config['PGPASSWORD'])
    password_file.chmod(0o600)
    run(['chown', 'postgres:postgres', str(password_file)])
    run(['chown', '-R', 'postgres:postgres', str(data)])
    pg = ['runuser', '-u', 'postgres', '--']
    run(pg + ['/usr/lib/postgresql/15/bin/initdb', '-D', str(data), '--username=testuser', '--pwfile=' + str(password_file), '--auth-host=scram-sha-256', '--auth-local=trust'])
    password_file.unlink()
    # The CA is scoped to this disposable fixture. Clients still use verify-full.
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Cloudflare Tailscale Test CA', '-keyout', str(root / 'ca.key'), '-out', str(root / 'ca.pem')])
    run(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=replica.cf-tailscale.test', '-keyout', str(data / 'server.key'), '-out', str(root / 'server.csr')])
    (root / 'cert.ext').write_text('subjectAltName=DNS:replica.cf-tailscale.test\nextendedKeyUsage=serverAuth\n')
    run(['openssl', 'x509', '-req', '-in', str(root / 'server.csr'), '-CA', str(root / 'ca.pem'), '-CAkey', str(root / 'ca.key'), '-CAcreateserial', '-days', '1', '-extfile', str(root / 'cert.ext'), '-out', str(data / 'server.crt')])
    (data / 'server.key').chmod(0o600)
    run(['chown', 'postgres:postgres', str(data / 'server.key'), str(data / 'server.crt')])
    (data / 'pg_hba.conf').write_text('local all all trust\nhostssl postgres testuser 100.64.0.0/10 scram-sha-256\n')
    with (data / 'postgresql.conf').open('a') as f:
        f.write(f"\nlisten_addresses = '{address}'\nssl = on\nssl_cert_file = 'server.crt'\nssl_key_file = 'server.key'\n")
    run(pg + ['/usr/lib/postgresql/15/bin/pg_ctl', '-D', str(data), '-l', str(data / 'postgres.log'), '-w', 'start'])
    stage = 'dns_setup'
    with (root / 'dnsmasq.log').open('w') as log:
        dns = subprocess.Popen(['dnsmasq', '--keep-in-foreground', '--bind-interfaces', '--listen-address=' + address, '--no-resolv', '--no-hosts', '--local=/cf-tailscale.test/', '--address=/replica.cf-tailscale.test/' + address], stdout=log, stderr=log)
    time.sleep(1)
    if dns.poll() is not None:
        raise RuntimeError('DNS fixture did not start')
    print(json.dumps({'passed': True, 'stage': 'ready', 'address': address, 'split_dns_zone': 'cf-tailscale.test', 'PGHOST': 'replica.cf-tailscale.test', 'PGDATABASE': 'postgres', 'PGUSER': 'testuser', 'PGSSLROOTCERT_PEM': (root / 'ca.pem').read_text()}))
except Exception as error:
    print(json.dumps({'passed': False, 'stage': stage, 'error_type': type(error).__name__}))
finally:
    key.unlink(missing_ok=True)
