FROM node:22-alpine

# git: package.json's sonos-discovery dependency is a GitHub-sourced
# install (github:jishi/node-sonos-discovery#v1.8.0 — see satellite/README.md
# for why: the npm-published version predates a Node 20 compat fix that
# only ever got tagged on GitHub) — npm needs git on the image to fetch
# it, and node:22-alpine doesn't ship it. Without this, `npm install`
# fails outright with `npm error syscall spawn git` / ENOENT — this was
# the actual reason the very first build-satellite.yml run ever failed,
# not anything about registry visibility or the compose race found
# afterward.
RUN apk add --no-cache git

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# API/controller only in this image — the frontend build is served by
# the satellite's nginx container instead, not baked in here. See
# designs/satellite-provisioning.md's "Docker + Watchtower deployment".
EXPOSE 4000
CMD ["node", "server.js"]
