FROM node:24-alpine

WORKDIR /app

# Dependencies first, so this layer is cached until package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js diagnose.js notes.js ./

# Baked in at build time: docker build --build-arg APP_VERSION=2 ...
ARG APP_VERSION=1
ENV APP_VERSION=$APP_VERSION
ENV PORT=3000
EXPOSE 3000

# The source stays root-owned and read-only to the app.
USER node
CMD ["node", "server.js"]
