FROM ghcr.io/openclaw/openclaw:2026.9.4@sha256:cc596b846506a5f4cfcee111394a2725f375f01cca2ebb492a161fd1b747f101
ARG PLOW_REVISION
LABEL org.opencontainers.image.revision=$PLOW_REVISION co.plow.probe=/opt/plow/probe
USER root
RUN mkdir -p /opt/plow/skills /var/lib/plow && chown node:node /var/lib/plow
COPY boot /opt/plow/boot
COPY plugin /opt/plow/plugin
COPY prompt /opt/plow/prompt
COPY skills /opt/plow/skills
COPY build.ts /opt/plow/build.ts
RUN cd /opt/plow/plugin && npm install --omit=peer --ignore-scripts && node /opt/plow/build.ts && chmod +x /opt/plow/probe
ENV OPENCLAW_STATE_DIR=/var/lib/plow OPENCLAW_CONFIG_PATH=/var/lib/plow/openclaw.json OPENCLAW_NO_RESPAWN=1 NODE_DISABLE_COMPILE_CACHE=1
# The inherited healthcheck loads config and can race the boot state lock.
HEALTHCHECK NONE
USER node
CMD ["node", "/opt/plow/boot/main.js"]
