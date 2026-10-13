"""Test a deployed Worker with real inference. Uses Gateway credits and Containers.

Set WORKER_URL and API_TOKEN in the environment. Results contain no caller token.
"""

import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request


base = os.environ["WORKER_URL"].rstrip("/")
token = os.environ["API_TOKEN"]
results = []


def call(path="/run", body=None, authenticated=True, method="POST"):
    headers = {"Content-Type": "application/json", "User-Agent": "hermes-production-smoke/1.0"}
    if authenticated:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        base + path, json.dumps(body).encode() if body is not None else None,
        headers, method=method,
    )
    start = time.monotonic()
    try:
        response = urllib.request.urlopen(req, timeout=330)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        text = response.read().decode()
        return response.status, text, round(time.monotonic() - start, 2)


for kwargs, expected in [
    ({"path": "/missing", "method": "GET"}, 404),
    ({"method": "GET"}, 405),
    ({"body": {}, "authenticated": False}, 401),
    ({"body": {"repository": "file:///etc", "prompt": "test"}}, 400),
]:
    status, text, _ = call(**kwargs)
    assert status == expected, (status, text)
    print(f"PASS: request boundary returned {status}", flush=True)

tasks = [
    (
        "Create hello.py with greet(name) returning 'Hello, ' + name + '!'. "
        "Create test_hello.py with unittest tests for greet('Cloudflare') and greet('Hermes'). "
        "Run python3 -B -m unittest -v test_hello.py using the terminal. Do not commit changes. "
        "Only if both tests pass, include PRODUCTION_SMOKE_PASSED in your final answer.",
        "PRODUCTION_SMOKE_PASSED",
    ),
    (
        "Run this exact multiline command with the terminal tool. Preserve the heredoc newlines. "
        "Do not create or edit files. Only report ISOLATION_SMOKE_PASSED if the command prints it.\n"
        "python3 -B - <<'PY'\n"
        "import os, pathlib, urllib.request, urllib.error\n"
        "assert not pathlib.Path('hello.py').exists()\n"
        "assert not pathlib.Path('test_hello.py').exists()\n"
        "assert 'API_TOKEN' not in os.environ\n"
        "assert 'AI_GATEWAY_API_TOKEN' not in os.environ\n"
        "try:\n"
        "    urllib.request.urlopen('https://pypi.org/simple/', timeout=10)\n"
        "except urllib.error.HTTPError as error:\n"
        "    assert error.code == 403, error.code\n"
        "else:\n"
        "    raise AssertionError('Package registry should be blocked')\n"
        "print('ISOLATION_SMOKE_PASSED')\n"
        "PY",
        "ISOLATION_SMOKE_PASSED",
    ),
]

for prompt, marker in tasks:
    status, text, seconds = call(body={"repository": "https://github.com/octocat/Hello-World", "prompt": prompt})
    result = json.loads(text)
    results.append({"status": status, "seconds": seconds, "result": result})
    out = Path(".wrangler/production-smoke.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2) + "\n")
    assert status == 200 and result.get("exitCode") == 0, result
    assert marker in result["stdout"], result
    if marker == "PRODUCTION_SMOKE_PASSED":
        assert "b/hello.py" in result["diff"] and "b/test_hello.py" in result["diff"], result
    else:
        assert not result["diff"], result
    print(f"PASS: {marker} ({seconds}s)", flush=True)

print(f"Saved results to {out}")
