# Original SaaS product vision (archived)

Multi-tenant product where non-technical users (shop owners, politicians, creators, illiterate voice-first users) chat in assets (images, video, docs, audio, music), get an agent that clarifies intent, presents consent with **credit cost**, charges a wallet, and produces brand ads / shorts / reels / YouTube / web-series parts.

## Intended surface

- Chat + multi-project / multi-part (series) timelines
- Cross-project gallery with ownership awareness + user notes + portable memory (embeddings)
- Live progressive preview; replay only the last change unit
- Personas / environments / concepts remembered across jobs
- Multi-agent: creative script agent ↔ feasibility validator ↔ specialized workers
- Stack ambition: Blender + Three.js + Remotion + Replicate (last resort) + crawl APIs + ElevenLabs/Sarvam + music + video understanding + Vercel AI SDK model routing with margin on token cost
- Credits: reserve in wallet, instant deduct with margin when cost incurred; top-up if insufficient

## SaaS domain extras (not in personal version)

- Auth, orgs, roles, per-user wallets and credit packs
- Consent dialog as legal/UX gate before spend
- Idempotent ledger (`job_id`), refunds on mid-render failure, race-safe double-job charging
- Rate cards with **margin** over provider COGS (not pass-through API $)
- Capability catalog marketed as product truth; support burden when Replicate deprecates models
- ToS, AUP, deepfake/likeness/election-ad policy, GDPR deletion of embeddings on asset delete
- Rights pipeline for crawled/stock assets (or ban crawl for commercial tenants)
- Multi-tenant isolation for storage, memory, and spend
- Unit economics dashboard (COGS vs retail credit price per 30s)
- Support for “illiterate” voice-first UX and Indic STT→script quality as product requirements
