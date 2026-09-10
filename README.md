# Chatshoot — Personal Video Production Studio

Local Docker Compose studio for by-order client videos. Not SaaS.

## Quick start

```bash
cp .env.example .env
# Fill OPENAI_API_KEY (and others) when ready

docker compose up --build
```

App: http://localhost:2980

## Services

| Service | Port | Role |
|---------|------|------|
| web | 3000 | Next.js UI + API |
| postgres | 5432 | Postgres + pgvector |
| redis | 6379 | BullMQ |
| worker-remotion | — | Remotion renders |
| worker-blender | — | Headless Blender (CPU) |
| worker-ingest | — | Embeddings, Azure Video Indexer, crawl |

## Docs

- [Studio plan (active)](./docs/studio-plan.md) — product frame, phases A–F status, order-desk slices, backlog
- [Operator cheat-sheet](./docs/operator.md) — VO:/slots/deltas/showroom
- [SaaS future (deferred)](./docs/saas-future/README.md)
- [Deploy to another VM](./docs/deploy-vm.md)

## Clean storage

- Per-project clean: Project page → Clean media
- Master flush: Settings → Flush all media (keeps spend history)
