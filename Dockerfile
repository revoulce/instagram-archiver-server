FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ARG GALLERY_DL_VERSION=1.32.14
# The slim image has no system CA bundle yet; bootstrap HTTPS with Node's trusted roots.
RUN node -e "const fs = require('node:fs'); fs.mkdirSync('/etc/ssl/certs', { recursive: true }); fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt', require('node:tls').rootCertificates.join('\n')); const p = '/etc/apt/sources.list.d/debian.sources'; fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('http://deb.debian.org', 'https://deb.debian.org'));" \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=15 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=15 install -y --no-install-recommends \
    python3 python3-venv ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/gallery-dl \
    && /opt/gallery-dl/bin/pip install --no-cache-dir gallery-dl==${GALLERY_DL_VERSION}
ENV PATH="/opt/gallery-dl/bin:${PATH}"
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/downloads && chown node:node /app/downloads
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
