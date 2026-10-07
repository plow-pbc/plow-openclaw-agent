#!/usr/bin/env bash
set -eo pipefail
cd "$(dirname "$0")/.."
image=${1:-plow-openclaw:test}
backend= proxy= restart_project= fixture_dir=
cleanup() {
  if [ -n "$restart_project" ]; then docker compose -p "$restart_project" -f "$fixture_dir/restart.json" down >/dev/null 2>&1 || true; fi
  if [ -n "$proxy" ]; then docker rm -f "$proxy" >/dev/null 2>&1 || true; fi
  if [ -n "$backend" ]; then docker rm -f "$backend" >/dev/null 2>&1 || true; fi
  if [ -n "$fixture_dir" ]; then rm -rf "$fixture_dir"; fi
}
trap cleanup EXIT

backend_script='
  import {createServer} from "node:http";
  createServer((req,res)=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(req.headers))}).listen(3000,"127.0.0.1");
'
backend=$(docker run -d --network none "$image" node --input-type=module -e "$backend_script")
probe_proxy() {
  docker exec -i "$1" node --input-type=module - "$2" <<'JS'
import assert from "node:assert/strict";
import {setTimeout} from "node:timers/promises";
const port=process.argv[2],url="http://127.0.0.1:3001/";
let ready=false;
for(let attempt=0;attempt<100;attempt++){
  try{ready=(await fetch(url,{signal:AbortSignal.timeout(1000)})).ok;if(ready)break}catch{}
  await setTimeout(100);
}
assert.ok(ready,"Caddy did not become ready");
for(const host of ["localhost","127.0.0.1"]){
  const response=await fetch(url,{headers:{Origin:`http://${host}:${port}`,"X-Plow-User":"forged-owner","X-Forwarded-Host":"forged.invalid","Forwarded":"for=forged","X-Real-IP":"forged"}});
  assert.equal(response.status,200);
  const headers=await response.json();
  assert.equal(headers.origin,"http://127.0.0.1:3000");
  assert.equal(headers.host,"127.0.0.1:3000");
  assert.equal(headers["x-plow-user"],"dev-owner");
  assert.equal(headers["x-forwarded-host"],"127.0.0.1:3001");
  assert.equal(headers.forwarded,undefined);
  assert.equal(headers["x-real-ip"],undefined);
}
for(const origin of ["https://example.invalid",`http://127.0.0.1:${port=== "3001"?3016:3001}`]){
  assert.equal((await fetch(url,{headers:{Origin:origin,"X-Plow-User":"dev-owner","X-Forwarded-Host":`127.0.0.1:${port}`}})).status,403);
}
console.log(`PASS development proxy port ${port}: accepted origins, foreign origins and spoofed headers`);
JS
}
for port in 3001 3016; do
  env_args=()
  if [ "$port" != 3001 ]; then env_args=(-e "PLOW_DEV_PORT=$port"); fi
  proxy=$(docker run -d --network "container:$backend" "${env_args[@]}" \
    -v "$PWD/dev/Caddyfile:/etc/caddy/Caddyfile:ro" \
    caddy:2@sha256:14a9c00d4e833ebc2b65d36515b37bde3b73f0b323a2663aaafc88953d8c4e3f)
  probe_proxy "$backend" "$port"
  docker rm -f "$proxy" >/dev/null
  proxy=
done

fixture_dir=$(mktemp -d)
cp compose.yml "$fixture_dir/compose.yml"
mkdir "$fixture_dir/dev"
cp dev/Caddyfile "$fixture_dir/dev/Caddyfile"
printf 'AGENT_ID=\n' > "$fixture_dir/plow-credentials"
PLOW_DEV_PORT=3016 docker compose -f "$fixture_dir/compose.yml" config --format json \
  | docker run --rm --network none -i "$image" node -e '
    let input="";
    process.stdin.on("data",chunk=>input+=chunk);
    process.stdin.on("end",()=>{
      const source=JSON.parse(input);
      console.log(JSON.stringify({services:{
        agent:{image:process.argv[1],network_mode:"none",entrypoint:["node","--input-type=module","-e",process.argv[2]]},
        "dev-dashboard":source.services["dev-dashboard"]
      }}));
    });
  ' "$image" "$backend_script" > "$fixture_dir/restart.json"
restart_project="plow-proxy-restart-$$"
docker compose -p "$restart_project" -f "$fixture_dir/restart.json" up --no-build -d
restart_backend=$(docker compose -p "$restart_project" -f "$fixture_dir/restart.json" ps -q agent)
probe_proxy "$restart_backend" 3016
docker compose -p "$restart_project" -f "$fixture_dir/restart.json" restart agent
probe_proxy "$restart_backend" 3016
printf 'PASS development proxy follows a Compose agent restart\n'
