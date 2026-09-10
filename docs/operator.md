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

## Showroom / Blender plate

Include **showroom**, **cafe**, **3d**, or **blender** in the brief:

```
Showroom blender plate into the SaaS kit. Keep existing titles.
```

Blender runs first; Remotion (and TTS if any) wait until the plate is written, then compose with `plateUrl` under `media/plates/`. With Blender on PATH you get a **Cycles PNG** (~showroom/cafe procedural kit); otherwise an SVG fallback. Titles/CTA are not wiped by the blender callback.

## Timeline beats

Kit beats: `logo` → `product` → `broll` → `cta`. Ask chat to change timings only:

```
Make the logo beat 1.5s and b-roll 18s
```

Approve ($0) — preview + beat strip update immediately. Next Remotion export bakes the new timings into MP4.

Say **export** / **bake** / **render mp4** in the same request to also enqueue a remotion bake on approve (small estimate).

API (for scripts): `POST /api/plans` with `{ "action":"revise_timeline", "projectId", "partId", "patches":[{"id":"logo","durSec":1.2}], "reexport": false }`.

## Export & reverse

- **Export MP4** on the project page (or plan with export on).
- **Reverse last step** restores the previous preview snapshot for that part.

## Smoke

```bash
./scripts/regression.sh
```

More detail: [studio-plan.md](./studio-plan.md).
