# eufy-bridge

Bridges a Eufy battery doorbell to Shinobi: `bridge.js` (eufy-security-client) →
MediaMTX `rtsp://<bridge-host>:8554/doorbell` → Shinobi monitor `doorbell`.
Read `README.md` first: architecture, setup, the live-on-demand viewer hook, and the traps.

- **This repo is public.** Keep site specifics out of it: no IPs, hostnames, domains,
  device serials, Shinobi group keys or monitor ids, names or emails. They belong in
  the operator's infra repo (which also holds the nginx viewer hook and the inventory
  that runs `shinobi/doorbell_monitor.py`). Use `<bridge-host>`, `<shinobi-host>`,
  `<group>` placeholders in docs, and env vars or flags in code.
- Secrets and state never live in the repo: credentials in `~/.config/eufy-bridge/env`
  (0600), session tokens and logs in `~/.local/state/eufy-bridge/`.
- Never print a Shinobi apiKey.
