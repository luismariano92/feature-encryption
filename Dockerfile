FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src/ src/
COPY tsconfig.json tsconfig.client.json ./
COPY public/index.html public/style.css public/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist/ dist/
COPY --from=build /app/public/ public/
COPY --from=build /app/package.json .
RUN echo '{"host":"0.0.0.0","stateFile":"/data/.backup-state.json","schedulesFile":"/data/backup-schedules.json"}' > /app/backup.config.docker.json
ENV BACKUP_CONFIG=/app/backup.config.docker.json
ENV PORT=3000
RUN mkdir -p /data
VOLUME /data
EXPOSE 3000
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && chown -R appuser:appgroup /app /data
USER appuser
CMD ["node", "dist/server/index.js"]
