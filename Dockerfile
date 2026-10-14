# Whittle: self-hosted web app, accounts and design storage in one small image (built from source).
#   docker build -t whittle .
#   docker run -p 8080:8080 -v whittle-data:/data whittle
# Settings are environment variables (see docs/SELF_HOSTING.md), e.g. -e WHITTLE_AUTH=none

FROM node:22-alpine AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM rust:1-alpine AS server
RUN apk add --no-cache musl-dev build-base
WORKDIR /src
COPY apps/server ./
RUN cargo build --release --locked

FROM alpine:3.20
RUN adduser -D -H -h /data whittle && mkdir /data && chown whittle /data
COPY --from=server /src/target/release/whittle-server /usr/local/bin/whittle-server
COPY --from=web /src/apps/web/dist /srv/whittle
ENV WHITTLE_BIND=0.0.0.0:8080 WHITTLE_WEB=/srv/whittle WHITTLE_DATA=/data
USER whittle
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["whittle-server"]
