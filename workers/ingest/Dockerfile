FROM node:22-bookworm-slim
WORKDIR /app
COPY workers/ingest/package*.json ./
RUN npm install
COPY workers/ingest ./
ENV MEDIA_ROOT=/media
CMD ["npm", "start"]
