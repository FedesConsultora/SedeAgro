FROM node:22-alpine@sha256:ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc AS dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "3000"]

FROM node:22-alpine@sha256:ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc AS build
WORKDIR /app
ARG RELEASE_SHA
RUN node -e 'if (!/^[0-9a-f]{40}$/.test(process.env.RELEASE_SHA || "")) process.exit(1)'
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.30.6-alpine3.24@sha256:ff8328b4279ec385af48cde9ef486e7165ad74b7065cb3cd86c377384e2e2dd5 AS prod
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision="${RELEASE_SHA}"
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Remove upstream Nginx sample HTML/error pages before publishing the
# manifest-bound Vite build. COPY alone leaves stock 50x.html behind.
RUN rm -rf /usr/share/nginx/html && mkdir -p /usr/share/nginx/html
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
