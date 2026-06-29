FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS dev
ENV NODE_ENV=development
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 3001
CMD ["npm", "run", "dev"]

FROM base AS prod
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY db ./db
COPY scripts ./scripts
EXPOSE 3001
CMD ["npm", "start"]
