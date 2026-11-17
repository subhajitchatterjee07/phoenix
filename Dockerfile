# One image for api, worker, dispatcher, migrate and the test servers (HLD §8).
FROM node:22.23.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY testing ./testing
RUN npm run build

FROM node:22.23.1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# migrate.js looks for ../migrations next to dist/src/
COPY migrations ./dist/migrations
USER node
