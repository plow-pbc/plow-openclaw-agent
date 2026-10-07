# Native gateway acceptance

This fixture starts the pinned OpenClaw gateway, the image-installed Plow plugin,
and local HTTP/WebSocket servers that stand in for Plow and the model provider.
It exercises actual routing, native workers, scheduler revisions, persisted
controls and the Agent Index usage reader. All participants and messages are
synthetic. It never loads `plow-credentials` or contacts a real line or the Index.

## Run the offline checks

Install the repository's test dependencies, build the image, and run the same
command as CI. Port 3000 exists only inside the container. `--network none`
allows its loopback fixtures while preventing external connections.

```sh
npm ci --ignore-scripts
docker build -t plow-openclaw:test .
docker run --rm --user root --network none \
  -v "$PWD/node_modules:/opt/plow/node_modules:ro" \
  -v "$PWD/tests:/opt/plow/tests:ro" plow-openclaw:test sh -c \
  'mkdir -p /opt/plow/plugin/node_modules && ln -s /app /opt/plow/plugin/node_modules/openclaw && node /opt/plow/tests/gateway-acceptance.ts'
```

Each `PASS` records an observed native effect. A failed assertion exits nonzero.
The fixture shuts down the gateway and removes its temporary state afterward.
Model responses are deterministic fixtures; this checks integration behavior,
not the quality of a real model's reasoning or tone.

## Inspect the personality page

After building `plow-openclaw:test`, start the visual fixture:

```sh
docker compose -p plow-acceptance -f tests/compose.acceptance.yml up -d
docker compose -p plow-acceptance -f tests/compose.acceptance.yml logs -f agent
```

Wait for `ACCEPTANCE_GATEWAY_READY`, then open
<http://localhost:3001/plugins/plow/personality>. The fixture stays running until
stopped, so you can exercise preview, save, stale edits, reset and mobile layout.
It uses the same `dev/Caddyfile` and pinned Caddy image as the normal development
dashboard. Only `127.0.0.1:3001` is published; anyone with access to that local
port administers this synthetic agent. Do not change the bind address or expose
this fixture through a tunnel. If port 3001 is occupied, set `PLOW_DEV_PORT=3017`
for all fixture Compose commands and open the page on port 3017. The mapping
and origin allowlist use that same value; the internal proxy still listens on 3001.

Verify the real development proxy separately:

```sh
bash tests/dev-proxy-acceptance.sh plow-openclaw:test
```

This starts the pinned Caddy with a synthetic backend in shared, isolated
container networking. It checks default and custom origins, foreign-origin
rejection, and replacement of spoofed owner/forwarding headers. It publishes
no host ports, loads no credentials and removes only its own containers.

Stop both services when finished:

```sh
docker compose -p plow-acceptance -f tests/compose.acceptance.yml down
```
