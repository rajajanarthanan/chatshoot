FROM node:22-bookworm-slim
WORKDIR /app
COPY workers/remotion/package*.json ./
RUN npm install
COPY workers/remotion ./
ENV MEDIA_ROOT=/media
CMD ["npm", "start"]
