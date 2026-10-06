FROM ghcr.io/openclaw/openclaw:2026.9.6@sha256:0a5ff5e682e62afa19149df126aa50063bf65ef885b5c94713ce32dc0eb12e15
ARG PLOW_REVISION
LABEL org.opencontainers.image.revision=$PLOW_REVISION org.opencontainers.image.licenses=MIT co.plow.probe=/opt/plow/probe
USER root
RUN mkdir -p /opt/plow/skills /var/lib/plow /etc/plow/openclaw && chown node:node /var/lib/plow /etc/plow/openclaw
COPY boot /opt/plow/boot
COPY boot/gateway-password.sh /etc/profile.d/plow-openclaw.sh
RUN printf '\n. /etc/profile.d/plow-openclaw.sh\n' >> /home/node/.bashrc
COPY LICENSE /opt/plow/LICENSE
COPY plugin /opt/plow/plugin
COPY prompt /opt/plow/prompt
COPY skills /opt/plow/skills
COPY eval /opt/plow/eval
COPY build.ts /opt/plow/build.ts
COPY patch-runtime.ts /opt/plow/patch-runtime.ts
COPY package.json package-lock.json tsconfig.json /opt/plow/

# The Agent Index usage reporter, fetched at build from an immutable commit and
# checked against its hash. Fetched rather than committed because
# plow-pbc/agent-index-client owns that file; a sha rather than a branch because
# this runs inside an agent holding a live credential, and a moving reference
# would substitute unreviewed code under it. The checksum is the second half: a
# sha in a URL is only as good as the host serving it. Bumping either is an edit
# somebody reviews.
#
# Root-owned, outside the state volume the agent writes: a copy the agent could
# write is a copy a turn can replace.
RUN curl -fsS --max-time 60 -o /opt/plow/agent-index-client.py \
      "https://raw.githubusercontent.com/plow-pbc/agent-index-client/fbfe8b635c1f20ce1f0152497abb419623f53329/standalone/agent_index_client.py" \
 && echo "5be521644ade0f041e83370ac457edc8ad85410e14265f1b1243807772de9a5b  /opt/plow/agent-index-client.py" | sha256sum -c - \
 && chmod 0644 /opt/plow/agent-index-client.py

# The compatibility collector. The pinned client also reads current OpenClaw
# SQLite transcripts directly and deduplicates against collector results. Pinned and checksummed for the same reason
# as the client above: it runs inside an agent holding a live credential.
ARG AGENTSVIEW_VERSION=0.44.0
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) checksum=037ea7a46d52e06b20363b4aa7cd7f28e32f31d8215803d6e9a0c96bac5818e3 ;; \
      arm64) checksum=6f3c76ebe119826a2def1ae226c3573b214d396a3ed7c477ef282b1063345b87 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsS --max-time 120 -L -o /tmp/agentsview.tgz \
      "https://github.com/kenn-io/agentsview/releases/download/v${AGENTSVIEW_VERSION}/agentsview_${AGENTSVIEW_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && echo "${checksum}  /tmp/agentsview.tgz" | sha256sum -c - \
 && tar -xzf /tmp/agentsview.tgz -C /usr/local/bin agentsview \
 && rm /tmp/agentsview.tgz \
 && chmod 0755 /usr/local/bin/agentsview
RUN cd /opt/plow && npm ci --omit=dev --omit=peer --omit=optional --ignore-scripts && node /opt/plow/patch-runtime.ts && node /opt/plow/build.ts && chmod +x /opt/plow/probe
# What the Agent Index page says the agent runs on. Without it the page falls
# back to its Hermes placeholder; a variant can override it.
ENV AGENT_RUNTIME=OpenClaw
ENV OPENCLAW_STATE_DIR=/var/lib/plow OPENCLAW_CONFIG_PATH=/var/lib/plow/openclaw.json OPENCLAW_INCLUDE_ROOTS=/etc/plow/openclaw OPENCLAW_NO_RESPAWN=1 NODE_DISABLE_COMPILE_CACHE=1
# HTTP readiness avoids taking the boot config lock and reports parked boots.
HEALTHCHECK --interval=30s --timeout=5s --start-period=150s --retries=3 CMD ["node", "/opt/plow/boot/health.js"]
USER node
CMD ["node", "/opt/plow/boot/main.js"]
