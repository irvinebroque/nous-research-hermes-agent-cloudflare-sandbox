"""Send a private configuration file to the deployed check without secrets in argv."""
import argparse
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url', required=True)
parser.add_argument('--token-file', required=True, type=Path)
parser.add_argument('--config-file', required=True, type=Path)
args = parser.parse_args()
url = urllib.parse.urlsplit(args.url)
if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
    parser.error('--url must be an HTTPS origin')
request = urllib.request.Request(args.url.rstrip('/') + '/check', data=args.config_file.read_bytes(), headers={
    'Authorization': 'Bearer ' + args.token_file.read_text().strip(),
    'Content-Type': 'application/json',
    'User-Agent': 'hermes-tailscale-test/1.0',
})
try:
    with urllib.request.urlopen(request, timeout=240) as response:
        result = json.load(response)
except urllib.error.HTTPError as error:
    raise SystemExit(f'Check returned HTTP {error.code}') from None
print(json.dumps(result, indent=2))
raise SystemExit(0 if result['passed'] else 1)
