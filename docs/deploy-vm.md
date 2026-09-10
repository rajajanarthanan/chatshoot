# Deploy Chatshoot to another VM

## Prerequisites

- Docker + Docker Compose v2
- Copy this repo (or `git clone`)
- Copy `.env` (never commit secrets)

## Steps

```bash
cp .env.example .env
# fill OPENAI_API_KEY and optional provider keys

docker compose up --build -d
docker compose ps
curl -s http://localhost:2980 | head
```

## Data portability

Volumes: `pgdata`, `blender-cache`, and bind mount `./media`.

Backup:

```bash
docker compose exec postgres pg_dump -U chatshoot chatshoot > backup.sql
tar czf media-backup.tgz media
```

Restore on new VM: start compose, `psql < backup.sql`, extract media.

## GPU (optional)

When NVIDIA drivers + nvidia-container-toolkit are installed, uncomment the `deploy.resources` block under `worker-blender` in `docker-compose.yml` and set `BLENDER_USE_GPU=1`.

CPU path remains the default and must work without a GPU.
