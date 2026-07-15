# syntax=docker/dockerfile:1.7
ARG MYCHAT_BUILD_REVISION=unknown
FROM node:24-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --legacy-peer-deps

COPY . .
RUN npm run build \
    && npm prune --ignore-scripts --omit=dev --legacy-peer-deps

FROM node:24-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS runtime

ARG MYCHAT_BUILD_REVISION
LABEL org.opencontainers.image.revision=$MYCHAT_BUILD_REVISION
ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1 \
    MYCHAT_BUILD_REVISION=$MYCHAT_BUILD_REVISION
WORKDIR /app

RUN apk add --no-cache ca-certificates git

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/lib ./lib
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/job-worker.ts /app/next.config.mjs /app/tsconfig.json ./

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
