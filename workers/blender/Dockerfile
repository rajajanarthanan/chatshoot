# CPU Blender image — optional nvidia device via compose override
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    blender ca-certificates \
    && rm -rf /var/lib/apt/lists/* || true
WORKDIR /app
COPY workers/blender/package*.json ./
RUN npm install
COPY workers/blender ./
ENV MEDIA_ROOT=/media
ENV BLENDER_BIN=blender
ENV BLENDER_USE_GPU=0
CMD ["npm", "start"]
