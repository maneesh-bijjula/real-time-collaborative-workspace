FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --no-audit --no-fund

FROM dependencies AS server-build
COPY apps/server apps/server
RUN npm run build -w apps/server

FROM node:24-bookworm-slim AS server
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=server-build /app/apps/server ./apps/server
USER node
EXPOSE 4000
CMD ["node", "apps/server/dist/index.js"]

FROM dependencies AS web-build
COPY apps/web apps/web
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_COLLABORATION_URL=ws://localhost:4000/collaboration
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_COLLABORATION_URL=$NEXT_PUBLIC_COLLABORATION_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w apps/web

FROM node:24-bookworm-slim AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
