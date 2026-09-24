if [ -r /var/lib/plow/gateway-password ]; then
  export OPENCLAW_GATEWAY_PASSWORD="$(cat /var/lib/plow/gateway-password)"
fi
