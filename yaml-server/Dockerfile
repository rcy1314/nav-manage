FROM node:20-alpine

ARG IMAGE_TAG=dev
ARG BUILD_TIME
ARG SOURCE_REVISION

LABEL org.opencontainers.image.title="yaml-server"
LABEL org.opencontainers.image.version="${IMAGE_TAG}"
LABEL org.opencontainers.image.created="${BUILD_TIME}"
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"

WORKDIR /app/server

ARG INSTALL_HUGO=true
RUN if [ "$INSTALL_HUGO" = "true" ]; then apk add --no-cache hugo; fi

COPY package*.json ./
ENV NODE_ENV=production
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 8990

ENTRYPOINT ["node","server.js"]
CMD []
