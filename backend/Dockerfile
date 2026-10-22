FROM node:22-alpine@sha256:ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS dev
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 3001
CMD ["npm", "run", "dev"]

FROM base AS prod
ARG RELEASE_SHA
ENV SEDEAGRO_BUILD_SHA=${RELEASE_SHA}
RUN node -e 'if (!/^[0-9a-f]{40}$/.test(process.env.SEDEAGRO_BUILD_SHA || "")) process.exit(1)'
LABEL org.opencontainers.image.revision="${RELEASE_SHA}"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY src ./src
COPY db ./db
COPY scripts ./scripts
EXPOSE 3001
CMD ["node", "src/server.js"]
