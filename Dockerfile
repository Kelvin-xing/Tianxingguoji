# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE

FROM ${NODE_IMAGE} AS dependencies
ARG NODE_IMAGE
WORKDIR /app

RUN printf '%s' "$NODE_IMAGE" | grep -Eq '^node:[A-Za-z0-9._-]+-alpine[A-Za-z0-9._-]*@sha256:[0-9a-f]{64}$' && \
  corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM ${NODE_IMAGE} AS builder
WORKDIR /app

RUN corepack enable
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

ARG GIT_SHA
ARG NEXT_DEPLOYMENT_ID
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV GIT_SHA=${GIT_SHA}
ENV NEXT_DEPLOYMENT_ID=${NEXT_DEPLOYMENT_ID}

RUN --mount=type=secret,id=next_server_actions_encryption_key,required=true \
  test -n "$GIT_SHA" && \
  test -n "$NEXT_DEPLOYMENT_ID" && \
  printf '%s' "$GIT_SHA" | grep -Eq '^[0-9a-f]{7,64}$' && \
  printf '%s' "$NEXT_DEPLOYMENT_ID" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' && \
  export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/next_server_actions_encryption_key)" && \
  test -n "$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY" && \
  pnpm build

FROM ${NODE_IMAGE} AS runner
ARG NODE_IMAGE
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN printf '%s' "$NODE_IMAGE" | grep -Eq '^node:[A-Za-z0-9._-]+-alpine[A-Za-z0-9._-]*@sha256:[0-9a-f]{64}$' && \
  addgroup -S -g 10001 nextjs && \
  adduser -S -D -H -u 10001 -G nextjs nextjs

COPY --from=builder --chown=10001:10001 /app/public ./public
COPY --from=builder --chown=10001:10001 /app/.next/standalone ./
COPY --from=builder --chown=10001:10001 /app/.next/static ./.next/static

USER 10001:10001
EXPOSE 3000
CMD ["node", "server.js"]
