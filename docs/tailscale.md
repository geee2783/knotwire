# Tailscale deployment (M6)

The API binds to loopback by default. Expose it to your tailnet without
opening inbound ports:

## Docker
```bash
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml --profile tailscale up -d
# authenticate the node (opens a browser/login URL)
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml --profile tailscale exec tailscale tailscale up --hostname=knotwire
# serve the API on the tailnet (HTTPS on 443 by default)
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml --profile tailscale exec tailscale tailscale serve --hostname=knotwire --https=443 http://127.0.0.1:8080
curl -k https://knotwire.<your-tailnet>.ts.net/healthz
```

## ACL (Tailscale admin console)
Allow tagged/individual devices to `100.x.y.z:443` (serve) or `:8080`.
Example:
```json
{ "acls": [ { "action": "accept", "src": ["autogroup:member"], "dst": ["knotwire:443"] } ] }
```

## Funnel (public; operator opt-in only)
```bash
tailscale funnel --hostname=knotwire --https=443 http://127.0.0.1:8080
```
Public HTTPS requires the API's auth/Security headers story above — do not
funnel a fresh install without API keys set up and `KNOTWIRE_JWT_SECRET` set.

## Kubernetes
The Helm chart exposes `.Values.tailscale` (annotation-based, Tailscale
operator expected). In-cluster `Service` stays ClusterIP; no ingress needed
on a tailnet-only setup.

## Environment
| Var | Purpose |
|---|---|
| `KNOTWIRE_JWT_SECRET` | signing secret for Bearer JWTs (required in production) |
| `KNOTWIRE_MASTER_KEY` | base64(32B) AES master key for encrypted fields (required in production) |
| `KNOTWIRE_RATE_LIMIT_PER_MIN` | per-tenant token bucket (default 600; multi-instance should move to Redis) |
| `KNOTWIRE_APPLY_MIGRATIONS=true` | dev-only: apply migrations at boot (default off; use `npm run db:setup`) |
