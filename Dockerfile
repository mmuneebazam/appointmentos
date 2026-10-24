# syntax=docker/dockerfile:1

# ─────────────────────────── deps ───────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
RUN npm ci

# ─────────────────────────── build ──────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time env only; real values are injected at run time.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build

# ─────────────────────────── runtime ────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl && addgroup -S app && adduser -S app -G app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

RUN chown -R app:app /app
USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
