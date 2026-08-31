FROM node:22-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

# The commit this bundle was built from — baked into the build as
# __GIT_SHA__ (see vite.config.js) and shown in the UI.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
