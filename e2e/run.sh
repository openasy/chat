#!/bin/bash
# End to end against a real Synapse: starts the version compose.yaml pins in Docker, on SQLite, with the settings Chat
# relies on (the registration shared secret, retention, no encryption by default), and runs Chat's server against it
# (e2e/synapse.ts). Needs Docker. Exits non-zero on failure.
set -u
cd "$(dirname "$0")/.."
IMAGE=$(sed -n 's/^ *image: \(ghcr.io\/element-hq\/synapse:[^ ]*\).*$/\1/p' compose.yaml)
PORT=${E2E_SYNAPSE_PORT:-18008}
NAME=chat-e2e-synapse
SECRET="e2e-secret-$(openssl rand -hex 16)"
DATA=$(mktemp -d)
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  docker run --rm -v "$DATA:/data" --entrypoint /bin/sh "$IMAGE" -c 'rm -rf /data/*' >/dev/null 2>&1
}
cleanup
[ -n "${E2E_KEEP:-}" ] || trap cleanup EXIT
chmod 777 "$DATA"
docker run --rm -v "$DATA:/data" -e SYNAPSE_SERVER_NAME=example.com -e SYNAPSE_REPORT_STATS=no "$IMAGE" generate >/dev/null
# The generated file has a secret of its own; Chat is given this one.
grep -v '^registration_shared_secret' "$DATA/homeserver.yaml" > "$DATA/homeserver.tmp" && mv "$DATA/homeserver.tmp" "$DATA/homeserver.yaml"
cat >> "$DATA/homeserver.yaml" <<YAML
registration_shared_secret: "$SECRET"
retention:
  enabled: true
encryption_enabled_by_default_for_room_type: "off"
presence:
  enabled: true
room_list_publication_rules:
  - { user_id: "@openasy-chat:*", action: allow }
  - { action: deny }
enable_authenticated_media: true
rc_message: { per_second: 1000, burst_count: 1000 }
rc_joins: { local: { per_second: 1000, burst_count: 1000 } }
rc_login: { address: { per_second: 1000, burst_count: 1000 }, account: { per_second: 1000, burst_count: 1000 } }
rc_admin_redaction: { per_second: 1000, burst_count: 1000 }
YAML
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8008" -v "$DATA:/data" "$IMAGE" >/dev/null
for _ in $(seq 1 90); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 1; done
echo "# $IMAGE on port $PORT"
SYNAPSE="http://localhost:$PORT" SYNAPSE_SECRET="$SECRET" node e2e/synapse.ts
status=$?
[ $status -eq 0 ] || docker logs --tail 60 "$NAME"
exit $status
