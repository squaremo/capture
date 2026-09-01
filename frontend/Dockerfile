FROM node:22-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

# The commit this bundle was built from — baked into the build as
# __GIT_SHA__ (see vite.config.js) and shown in the UI.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

# Which house this build "is" — empty for the general frontend image;
# a satellite's own build would set this. See vite.config.js.
ARG DEFAULT_HOUSE=
ENV DEFAULT_HOUSE=$DEFAULT_HOUSE

RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
