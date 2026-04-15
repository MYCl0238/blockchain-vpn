# Architecture (Interim)

- Protocol plane: UDP prototype with X25519 handshake + PSK auth + ChaCha20-Poly1305
- Control plane: HTTP API with token auth and profile orchestration
- Monitoring plane: keepalive/event ingest + session/metrics query APIs

This aligns with the interim report milestone of delivering a first working protocol plus backend integration hooks.
