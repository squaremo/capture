FROM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# The commit this image was built from — reported at GET /api/version.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

EXPOSE 3000
CMD ["node", "server.js"]
