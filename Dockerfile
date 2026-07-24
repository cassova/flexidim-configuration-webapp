FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV CONFIG_DIR=/config
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/bridge ./bridge
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
RUN mkdir -p /config && chown -R node:node /app /config
USER node
VOLUME ["/config"]
EXPOSE 3000 8765
CMD ["node", "server/host.mjs"]
