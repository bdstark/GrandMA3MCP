# gma3-mcp: MCP server for grandMA3 onPC, packaged so the host only needs Docker.
#
# Build:  docker build -t gma3-mcp .
# Run (as an MCP stdio server; the client launches this command):
#   docker run -i --rm --add-host=host.docker.internal:host-gateway gma3-mcp
#
# The bridge plugin runs inside onPC on the host, so the container talks to the host.
# On Docker Desktop (macOS/Windows) host.docker.internal works out of the box; on Linux use
# --network host (and keep the plugin on 127.0.0.1) or start the plugin bound to all interfaces:
#   Plugin "gma3_mcp_bridge" "0.0.0.0:9800"
#
# Mount the grandMA3 install folder read-only to enable gma3_help:
#   -v "$HOME/MALightingTechnology:/gma3:ro" -e GMA3_INSTALL_DIR=/gma3

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    GMA3_BRIDGE_HOST=host.docker.internal \
    GMA3_OSC_HOST=host.docker.internal \
    GMA3_INSTALL_DIR=/gma3
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY plugin ./plugin
COPY scripts ./scripts
USER node
ENTRYPOINT ["node", "dist/index.js"]
