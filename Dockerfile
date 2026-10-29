FROM ghcr.io/openclaw/openclaw:2026.9.33@sha256:ced9bfaf2514f9ec6bb217261614907662322837667513328d8bc90222c41e0c
ARG PLOW_REVISION
LABEL org.opencontainers.image.revision=$PLOW_REVISION co.plow.probe=/opt/plow/probe
USER root
# iPhone photos are HEIC. OpenClaw's image library decodes HEIC only through a native
# tool, and the base image ships none, so a texted photo reached the model as
# "[Image attachment could not be analyzed]". Debian's ImageMagick reads it through
# libheif. These are images strangers text the agent, so imagemagick-policy.xml
# limits ImageMagick to that one job.
RUN apt-get update && apt-get install -y --no-install-recommends imagemagick && rm -rf /var/lib/apt/lists/*
COPY imagemagick-policy.xml /etc/ImageMagick-6/policy.xml
# A standby gateway for in-place upgrades (#110): see patches/openclaw-standby.ts.
COPY patches /opt/plow/patches
RUN node /opt/plow/patches/openclaw-standby.ts /app
RUN mkdir -p /opt/plow/skills /var/lib/plow /etc/plow/openclaw && chown node:node /var/lib/plow /etc/plow/openclaw
COPY boot /opt/plow/boot
COPY boot/gateway-password.sh /etc/profile.d/plow-openclaw.sh
RUN printf '\n. /etc/profile.d/plow-openclaw.sh\n' >> /home/node/.bashrc
COPY plugin /opt/plow/plugin
COPY prompt /opt/plow/prompt
COPY skills /opt/plow/skills
COPY build.ts /opt/plow/build.ts
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

# The collector the reporter reads. agentsview covers OpenClaw sessions, so with
# it installed the usage half stops reading zero; without it the client still
# registers and reports empty days. Pinned and checksummed for the same reason
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

# latch, the client that reaches the owner's Mac when it runs the newer Latch
# (the `latch` CLI, Latch 149 on): its first call logs in as this agent through
# PLOW_API_BASE, the proxy every Plow call here already goes through. The client
# alone (no host, browser engine or sandbox), pinned and checksummed for the
# same reason as the two above. Its key and login live in the state volume
# (LATCH_STATE_DIR below), so an upgrade keeps the same peer.
ARG LATCH_TAG=v0.1.0-149
RUN case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-musl checksum=7ba6a41df3d1ba8856c896c40003044ce2d97775d608a42e218075409e378605 ;; \
      arm64) target=aarch64-unknown-linux-musl checksum=fb2ac25008659e6310ea64eadb61d1c550245b22edfdeff878c81737cd8e752e ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsS --max-time 120 -L -o /tmp/latch.tgz \
      "https://releases.plow.co/latch-cli/releases/${LATCH_TAG}/latch-${LATCH_TAG}-${target}.tar.gz" \
 && echo "${checksum}  /tmp/latch.tgz" | sha256sum -c - \
 && tar -xzf /tmp/latch.tgz -C /tmp "latch-${LATCH_TAG}-${target}/latch" \
 && install -m 0755 "/tmp/latch-${LATCH_TAG}-${target}/latch" /usr/local/bin/latch \
 && rm -rf /tmp/latch.tgz "/tmp/latch-${LATCH_TAG}-${target}"
RUN cd /opt/plow && npm ci --omit=dev --omit=peer --omit=optional --ignore-scripts && node /opt/plow/build.ts && chmod +x /opt/plow/probe
# What the Agent Index page says the agent runs on. Without it the page falls
# back to its Hermes placeholder; a variant can override it.
ENV AGENT_RUNTIME=OpenClaw
# Surface the image revision to the runtime so report_bug can name the build a
# report came from. It is otherwise only an image label, unreadable by a tool.
ENV PLOW_REVISION=$PLOW_REVISION
ENV LATCH_STATE_DIR=/var/lib/plow/latch
ENV OPENCLAW_STATE_DIR=/var/lib/plow OPENCLAW_CONFIG_PATH=/var/lib/plow/openclaw.json OPENCLAW_INCLUDE_ROOTS=/etc/plow/openclaw OPENCLAW_NO_RESPAWN=1 NODE_DISABLE_COMPILE_CACHE=1
# The inherited healthcheck loads config and can race the boot state lock.
HEALTHCHECK NONE
# The modules a gateway loads after it takes the state lock, which a standby preloads: recorded from
# one offline boot of this image (the probe), whose state is then removed.
RUN OPENCLAW_GATEWAY_WARM_RECORD=/opt/plow/openclaw-warm-modules.txt NODE_OPTIONS="--import /opt/plow/boot/warm-record.js" /opt/plow/probe \
 && test -s /opt/plow/openclaw-warm-modules.txt \
 && chmod 0644 /opt/plow/openclaw-warm-modules.txt \
 && find /var/lib/plow /etc/plow/openclaw -mindepth 1 -delete \
 && rm -rf /tmp/openclaw* /root/.openclaw \
 && test -z "$(find /var/lib/plow /etc/plow/openclaw -mindepth 1)"
USER node
CMD ["node", "/opt/plow/boot/main.js"]
