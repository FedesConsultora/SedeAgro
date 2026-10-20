FROM node:22-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "3000"]

FROM node:22-alpine AS build
WORKDIR /app
ARG RELEASE_SHA
RUN node -e 'if (!/^[0-9a-f]{40}$/.test(process.env.RELEASE_SHA || "")) process.exit(1)'
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS prod
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision="${RELEASE_SHA}"
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
