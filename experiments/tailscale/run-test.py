"""Invoke fixed, authenticated test operations without putting secrets in argv."""
import argparse
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url', required=True, help='HTTPS origin of the test Worker')
parser.add_argument('--token-file', required=True, type=Path)
parser.add_argument('--config-file', type=Path)
parser.add_argument('--operation', choices=('fixture', 'acceptance', 'cleanup'), default='acceptance')
parser.add_argument('--repeat', type=int, default=1, choices=(1, 2))
args = parser.parse_args()
url = urllib.parse.urlsplit(args.url)
if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
    parser.error('--url must be an HTTPS origin')
if args.operation != 'cleanup' and not args.config_file:
    parser.error('--config-file is required')
if args.repeat > 1 and args.operation != 'acceptance':
    parser.error('--repeat is only valid for acceptance')
body = args.config_file.read_bytes() if args.config_file else b'{}'
json.loads(body)
results = []
for _ in range(args.repeat):
    request = urllib.request.Request(args.url.rstrip('/') + '/' + args.operation, data=body, method='POST', headers={
        'Authorization': 'Bearer ' + args.token_file.read_text().strip(),
        'Content-Type': 'application/json',
        'User-Agent': 'hermes-tailscale-test/1.0',
    })
    try:
        with urllib.request.urlopen(request, timeout=240) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        # Do not print request headers or server error pages.
        raise SystemExit(f'Test endpoint returned HTTP {error.code}') from None
    results.append(result)
    if result.get('passed') is False:
        print(json.dumps(results, indent=2))
        raise SystemExit(1)
if args.repeat == 2:
    if len({r['boot_id'] for r in results}) != 2 or len({r['node_id'] for r in results}) != 2:
        raise SystemExit('Replacement test failed: expected two fresh containers and tailnet identities')
print(json.dumps(results, indent=2))
