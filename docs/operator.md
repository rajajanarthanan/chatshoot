# Operator cheat-sheet

Quick commands for Chatshoot on a project (e.g. HumanTest1). Chat → plan → cost OK → approve.

## Kit slots (Gallery)

On each gallery asset, set **Kit slot**:

| Slot | Use |
|------|-----|
| Logo | Brand mark |
| Product · UI | Screenshot / product still |
| B-roll | Footage (persona, walkthrough) |
| Music | Bed under VO |
| Auto | Filename / notes heuristics |

One pin per slot per project. Pins beat heuristics on the next plan.

## Brief labels

Put these on their own lines (or in a revise):

```
Title: Automate Your Business Workflows
Subtitle: Business memory for video, posts, and your store
CTA: Book a demo
Brand: AgentiqMinds
VO: Meet AgentiqMinds. Automate workflows in one place — video, posts, and your store. Book a demo today.
```

- `VO:` → spoken script (skips the short template VO)
- `no music` anywhere → skip the soft bed

## Revise deltas (saves spend)

| You say | Plan runs | Keeps |
|---------|-----------|--------|
| `VO: …` or “longer voiceover” | TTS (+ re-export) | Kit visuals |
| Title / Subtitle / CTA only | Remotion only | Existing VO + music |
| Stack top/bottom, crop 9:16, trim | Remotion + ffmpeg | Existing VO + music |
| Full new promo brief | Remotion + TTS as needed | — |

Approve when the cost dialog appears (`approve` / `ok` in chat also works).

## Timeline (CapCut spine)

Kit beats still mirror as `logo` → `product` → `broll` → `cta`. The source of truth is **`timeline_json` v2** (`tracks.V1` + `A1`/`A2`).

Ask chat for timings or freeform cuts:

```
Make the logo beat 1.5s and b-roll 18s
Split the b-roll into three cuts
```

On the project page: click a **V1 clip** → Split / Delete / Trim. Approve ($0) unless you ask to bake/export.

API: `POST /api/plans` with `action:"revise_timeline"`, `patches` and/or `clipOps` (`split|trim|reorder|delete|insert|volume`).

## Asset library + Poly Haven

Gallery filters: category (`hdri|texture|model|…`), source (`upload|polyhaven|crawl`), search. Enrich **notes** / `metadata.physical` (e.g. “oak desk 1.2m”).

Import CC0: Gallery → **Import Poly Haven**, or agent tool `import_polyhaven`. Files land under `media/library/polyhaven/`.

## Environments (assemble)

`GET/POST /api/environments` — bind `assetIds` (HDRI, props). Brief keywords: **sofa**, **HDRI**, **assemble**, **environment** → Blender `assemble.py` → plate clip on V1. Or reuse a named env via `environmentId` on the plan. **Save as environment** via agent `save_environment`.

Quality = quality of library assets + lighting (not prompt→photoreal).

## Personas + GenFill

`GET/POST /api/personas` — `refAssetIds`, `voiceId`, notes. Agent: `save_persona` / `list_personas`. Brief with **persona** / **genfill** runs image-edit → i2v pipeline (catalog-clamped ≤5s) and inserts a timeline clip when media returns. Likeness/policy is operator-owned.

## Showroom / Blender plate

Include **showroom**, **cafe**, **3d**, or **blender** in the brief:

```
Showroom blender plate into the SaaS kit. Keep existing titles.
```

Blender runs first; Remotion (and TTS if any) wait until the plate is written, then compose with `plateUrl` under `media/plates/`. With Blender on PATH you get a **Cycles PNG**; otherwise an SVG fallback. Titles/CTA are not wiped.

## Export & reverse

- **Export MP4** on the project page (or plan with export on).
- **Reverse last step** restores the previous preview snapshot for that part (includes `timelineJson`).

## Smoke

```bash
./scripts/regression.sh
```

More detail: [studio-plan.md](./studio-plan.md).
