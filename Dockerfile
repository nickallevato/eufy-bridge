# eufy-bridge: the bridge process only. MediaMTX runs as its own container
# (see compose.yml), from the upstream image.
#
# trixie, not bookworm: its ffmpeg is 7.1, the generation the SPS-matching
# encoder flags in bridge.js were checked against (bookworm ships 5.1).
FROM node:22-trixie-slim

# ffmpeg encodes the idle loop and the live re-encode and muxes to RTSP;
# fonts-dejavu-core is the idle-loop label font (bridge.js FONT); tzdata so
# REFRESH_HOURS and the "last live HH:MM" label follow TZ instead of UTC.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bridge.js ./
COPY tools ./tools

# /state holds the Eufy session (persistent.json: keep it, or the next login is
# a new device and Eufy emails a code), the last frame and the idle loop.
# Mount it; the bridge writes tfa-code / captcha.png prompts there too.
RUN mkdir -p /state && chown node:node /state
USER node
ENV NODE_ENV=production \
    STATE_DIR=/state \
    CONTROL_PORT=8099

EXPOSE 8099
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.CONTROL_PORT+'/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "bridge.js"]
