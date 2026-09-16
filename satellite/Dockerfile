FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# API/controller only in this image — the frontend build is served by
# the satellite's nginx container instead, not baked in here. See
# designs/satellite-provisioning.md's "Docker + Watchtower deployment".
EXPOSE 4000
CMD ["node", "server.js"]
