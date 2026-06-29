FROM node:20-alpine AS dev
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "3000"]

FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS prod
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
