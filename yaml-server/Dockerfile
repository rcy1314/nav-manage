FROM node:16-alpine

ARG IMAGE_TAG=dev
ARG BUILD_TIME
ARG SOURCE_REVISION

LABEL org.opencontainers.image.title="yaml-server"
LABEL org.opencontainers.image.version="${IMAGE_TAG}"
LABEL org.opencontainers.image.created="${BUILD_TIME}"
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"

RUN apk add --no-cache hugo git curl

WORKDIR /app/server

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 8990

CMD ["node","server.js"]
