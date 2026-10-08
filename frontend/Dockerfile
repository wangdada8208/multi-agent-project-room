FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY . .
ARG VITE_XMTP_WORKER_ADDRESS
ARG VITE_XMTP_ENV=production
ENV VITE_XMTP_WORKER_ADDRESS=$VITE_XMTP_WORKER_ADDRESS
ENV VITE_XMTP_ENV=$VITE_XMTP_ENV
RUN node scripts/validate-release-config.mjs && npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
