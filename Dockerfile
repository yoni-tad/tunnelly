# Tunnelly server. Dokploy (or plain Docker) builds this straight from git.
FROM node:22-alpine

WORKDIR /app

# Install dependencies first so Docker can cache this layer.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY cli/package.json cli/
COPY examples/local-app/package.json examples/local-app/
RUN npm ci

COPY . .
RUN npm run build -w server && npm prune --omit=dev

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:4000/_tunnelly/health || exit 1

USER node
CMD ["node", "server/dist/server.js"]
