FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Retries and generous timeouts: this install pulls ~700MB and a single dropped
# connection used to fail the whole build with ECONNRESET. npm gives up after
# two tries by default, which is not enough over a flaky link.
RUN npm ci --no-audit --no-fund \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV CONFIG_DIR=/config
# Set ownership while copying. A separate `chown -R /app` forces overlayfs to
# copy every runtime file into another layer, adding roughly 430 MB to every
# rebuilt image.
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/server ./server
COPY --chown=node:node --from=build /app/bridge ./bridge
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/package.json ./package.json
RUN mkdir -p /config && chown node:node /config
USER node
# No VOLUME instruction here on purpose. Both compose services share this image,
# but only the web service mounts anything at /config — the bridge has no use for
# it. A VOLUME line would make Docker create a fresh ANONYMOUS volume for the
# bridge on every container create, and `compose down` does not remove those, so
# each rebuild would leak one until the disk fills. The web service's named
# volume in compose works fine without it.
EXPOSE 3000 8765
# The default command supervises both the web host and the bridge, so a plain
# `docker run` of this image is a complete single-container deployment. Compose
# overrides the command per service to keep running them separately.
CMD ["node", "server/start-all.mjs"]
