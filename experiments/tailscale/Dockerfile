FROM tailscale/tailscale:v1.104.1 AS tailscale
FROM python:3.13-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl dnsmasq iproute2 iptables openssl postgresql postgresql-client tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY probe.py /opt/probe.py
COPY server.py /opt/server.py
COPY acceptance.py fixture.py /opt/
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "/opt/server.py"]
