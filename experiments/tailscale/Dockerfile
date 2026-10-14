FROM tailscale/tailscale:v1.104.1 AS tailscale
FROM python:3.13-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates iproute2 iptables postgresql-client tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY check.py /opt/check.py
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
