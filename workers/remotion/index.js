import { Worker } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { applyVideoEdits, exportKitMp4 } from "./edit.js";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://chatshoot:chatshoot@localhost:5432/chatshoot";
const MEDIA_ROOT = process.env.MEDIA_ROOT || join(process.cwd(), "../../media");
const WEB_CALLBACK =
  process.env.WEB_CALLBACK_URL || "http://web:3000/api/workers/callback";
const WEB_CALLBACK_LOCAL =
  process.env.WEB_CALLBACK_LOCAL || "http://localhost:2980/api/workers/callback";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

function mediaUrlToRel(url) {
  if (!url) return null;
  const s = String(url);
  if (!s.includes("/api/media")) {
    // already relative path
    if (!s.startsWith("http") && !s.startsWith("/")) return s;
    return null;
  }
  try {
    const u = new URL(s, "http://localhost");
    return u.searchParams.get("path");
  } catch {
    const m = s.match(/path=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

function relToMediaUrl(rel) {
  if (!rel) return null;
  return `/api/media?path=${encodeURIComponent(rel)}`;
}

async function callback(body) {
  for (const url of [WEB_CALLBACK, WEB_CALLBACK_LOCAL]) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return;
    } catch {
      /* try next */
    }
  }
}

async function handleRemotion(job) {
  const { jobId, partId, payload = {}, kind } = job.data;
  const titleText = payload.titleText || payload.title || "Chatshoot Promo";
  const subtitle = payload.subtitle || payload.instruction || "Generated short";

  if (kind === "tts") {
    const text = payload.text || `${titleText}. ${subtitle}`.slice(0, 400);
    const provider = payload.provider === "sarvam" ? "sarvam" : "elevenlabs";
    await mkdir(join(MEDIA_ROOT, "audio"), { recursive: true });
    const rel = `audio/${jobId}.txt`;
    await writeFile(join(MEDIA_ROOT, rel), text);
    let usedVoiceId = payload.voiceId || null;
    let voiceMeta = {};
    let audioRel = null;

    if (provider === "elevenlabs" && process.env.ELEVENLABS_API_KEY) {
      try {
        if (payload.createVoice?.name) {
          if (payload.createVoice.sampleBase64) {
            const form = new FormData();
            form.append("name", payload.createVoice.name);
            if (payload.createVoice.description) {
              form.append("description", payload.createVoice.description);
            }
            const bin = Buffer.from(payload.createVoice.sampleBase64, "base64");
            form.append(
              "files",
              new Blob([bin], { type: payload.createVoice.sampleMime || "audio/mpeg" }),
              "sample.mp3"
            );
            const created = await fetch("https://api.elevenlabs.io/v1/voices/add", {
              method: "POST",
              headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
              body: form,
            });
            const createdData = await created.json();
            if (created.ok && createdData.voice_id) {
              usedVoiceId = createdData.voice_id;
              voiceMeta = { created: true, name: payload.createVoice.name };
            }
          }
        }

        if (!usedVoiceId) {
          const listRes = await fetch("https://api.elevenlabs.io/v1/voices", {
            headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
          });
          const listData = await listRes.json();
          const voices = listData.voices || [];
          const lang = String(payload.language || "").toLowerCase();
          const gender = String(payload.gender || "").toLowerCase();
          const hint = String(payload.voiceHint || payload.persona || "").toLowerCase();
          let best = voices[0];
          let bestScore = -1;
          for (const v of voices) {
            const blob = `${v.name} ${Object.values(v.labels || {}).join(" ")}`.toLowerCase();
            let score = 0;
            if (lang && blob.includes(lang)) score += 3;
            if (gender && blob.includes(gender)) score += 2;
            if (hint && blob.includes(hint)) score += 4;
            if (score > bestScore) {
              bestScore = score;
              best = v;
            }
          }
          usedVoiceId = best?.voice_id || process.env.ELEVENLABS_VOICE_ID || null;
          voiceMeta = { picked: best?.name, score: bestScore };
        }

        if (usedVoiceId) {
          const res = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${usedVoiceId}`,
            {
              method: "POST",
              headers: {
                "xi-api-key": process.env.ELEVENLABS_API_KEY,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
              },
              body: JSON.stringify({
                text: text.slice(0, 1000),
                model_id: "eleven_multilingual_v2",
              }),
            }
          );
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            audioRel = `audio/${jobId}.mp3`;
            await writeFile(join(MEDIA_ROOT, audioRel), buf);
          }
        }
      } catch (e) {
        console.warn("elevenlabs failed", e);
      }
    }

    // Keep kit props; only layer VO/captions. Re-export if we already have a kit.
    let partPrev = {};
    if (partId) {
      try {
        const { rows } = await pool.query(`SELECT preview_props FROM parts WHERE id = $1`, [partId]);
        partPrev = rows[0]?.preview_props || {};
      } catch {
        /* */
      }
    }

    const captionLines = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6);

    let exportRel = partPrev.exportUrl ? mediaUrlToRel(partPrev.exportUrl) : null;
    if (audioRel && (partPrev.kit === "saas_promo" || payload.reexport !== false)) {
      try {
        const logoRel = mediaUrlToRel(partPrev.logoUrl || payload.logoUrl);
        const productRel = mediaUrlToRel(partPrev.productImageUrl || payload.productImageUrl);
        const brollRel = mediaUrlToRel(partPrev.brollUrl || payload.brollUrl);
        const musicRelIn =
          mediaUrlToRel(partPrev.musicUrl || payload.musicUrl) || payload.musicPath || null;
        const exported = await exportKitMp4({
          mediaRoot: MEDIA_ROOT,
          jobId: `${jobId}-vo`,
          titleText: partPrev.titleText || titleText,
          subtitle: partPrev.subtitle || subtitle,
          ctaText: partPrev.ctaText || payload.ctaText || "Start automating",
          brandName: partPrev.brandName || payload.brandName || "Chatshoot",
          logoAbs: logoRel ? join(MEDIA_ROOT, logoRel) : null,
          productAbs: productRel ? join(MEDIA_ROOT, productRel) : null,
          brollAbs: brollRel ? join(MEDIA_ROOT, brollRel) : null,
          audioAbs: join(MEDIA_ROOT, audioRel),
          captions: captionLines,
          durationSec: Number(partPrev.durationSec || payload.durationSec || 30),
          music: payload.music !== false,
          musicAbs: musicRelIn ? join(MEDIA_ROOT, musicRelIn) : null,
        });
        exportRel = exported.outputRel;
        if (exported.musicRel) {
          partPrev.musicUrl = relToMediaUrl(exported.musicRel);
        } else if (musicRelIn) {
          partPrev.musicUrl = relToMediaUrl(musicRelIn);
        }
        if (partId) {
          await pool.query(`UPDATE parts SET output_path = $1, updated_at = now() WHERE id = $2`, [
            exportRel,
            partId,
          ]);
        }
      } catch (e) {
        console.warn("vo re-export failed", e);
      }
    }

    await callback({
      jobId,
      status: "completed",
      previewProps: {
        audioUrl: audioRel ? relToMediaUrl(audioRel) : null,
        musicUrl: partPrev.musicUrl || null,
        voLabel: text.slice(0, 80),
        voScript: text,
        captions: captionLines,
        exportUrl: exportRel ? relToMediaUrl(exportRel) : partPrev.exportUrl || null,
      },
      lastChangeSummary: `Added VO (${provider}${usedVoiceId ? `:${usedVoiceId.slice(0, 8)}` : ""})${partPrev.musicUrl ? " + music" : ""}${exportRel ? " · re-exported" : ""}`,
      result: { audioPath: audioRel || rel, voiceId: usedVoiceId, voiceMeta, exportRel, musicUrl: partPrev.musicUrl || null },
      settle: {
        provider,
        unitKind: "character",
        units: text.length,
      },
    });
    return;
  }

  if (kind === "replicate") {
    const durationSec = Math.min(Number(payload.durationSec || 3), 5);
    let outputUrl = null;
    let usedModel = payload.modelSlug || payload.model || null;
    let usedVersion = payload.modelVersion || null;

    if (process.env.REPLICATE_API_TOKEN) {
      try {
        // Resolve version dynamically — agent picks model slug; no fixed REPLICATE_MODEL_VERSION required
        if (!usedVersion) {
          const slug = usedModel || "kwaivgi/kling-v2.5-turbo-pro";
          usedModel = slug;
          if (slug.includes("/")) {
            const [owner, name] = slug.split("/");
            const meta = await fetch(`https://api.replicate.com/v1/models/${owner}/${name}`, {
              headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` },
              signal: AbortSignal.timeout(15000),
            });
            const metaData = await meta.json();
            usedVersion = metaData.latest_version?.id;
          } else {
            usedVersion = slug;
          }
        }
        // Optional env override only if resolution failed
        if (!usedVersion) usedVersion = process.env.REPLICATE_MODEL_VERSION || null;

        if (usedVersion && !payload.mockOnly) {
          const res = await fetch("https://api.replicate.com/v1/predictions", {
            method: "POST",
            headers: {
              Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
              "Content-Type": "application/json",
              Prefer: "wait",
            },
            signal: AbortSignal.timeout(45000),
            body: JSON.stringify({
              version: usedVersion,
              input: {
                prompt: payload.prompt || "cinematic product shot",
                duration: durationSec,
                ...(payload.input || {}),
              },
            }),
          });
          const data = await res.json();
          outputUrl = data.output;
          if (Array.isArray(outputUrl)) outputUrl = outputUrl[0] || null;
        }
      } catch (e) {
        console.warn("replicate call failed, using mock", e);
      }
    }
    await mkdir(join(MEDIA_ROOT, "renders"), { recursive: true });
    const rel = `renders/genfill-${jobId}.json`;
    await writeFile(
      join(MEDIA_ROOT, rel),
      JSON.stringify(
        {
          mock: !outputUrl,
          durationSec,
          prompt: payload.prompt,
          model: usedModel,
          version: usedVersion,
          outputUrl,
        },
        null,
        2
      )
    );

    // Fuse into kit — never wipe title/subtitle/CTA/bg from an existing part
    let partPrev = {};
    if (partId) {
      try {
        const { rows } = await pool.query(`SELECT preview_props FROM parts WHERE id = $1`, [partId]);
        partPrev = rows[0]?.preview_props || {};
      } catch (e) {
        console.warn("genfill part load failed", e);
      }
    }
    const genfillUrl = outputUrl || null;
    /** @type {Record<string, unknown>} */
    const previewProps = {
      genfillUrl,
      genfillMeta: {
        durationSec,
        model: usedModel || null,
        mock: !outputUrl,
      },
    };
    // Only seed kit when empty; if part has no b-roll yet, use patch as b-roll beat
    if (genfillUrl && !partPrev.brollUrl) {
      previewProps.brollUrl = genfillUrl;
    }
    if (!partPrev.kit && (partPrev.logoUrl || partPrev.productImageUrl || partPrev.brollUrl || genfillUrl)) {
      previewProps.kit = "saas_promo";
    }

    await callback({
      jobId,
      status: "completed",
      previewProps,
      lastChangeSummary: `GenFill ${durationSec}s (${usedModel || "mock"})${genfillUrl ? " · fused" : " · mock marker only"}`,
      result: { path: rel, outputUrl, model: usedModel, version: usedVersion },
      settle: { provider: "replicate", unitKind: "second", units: durationSec },
    });
    return;
  }

  // Default remotion compose — edit footage when requested, then update preview + optional export
  const brandName = payload.brandName || null;
  let logoUrl = payload.logoUrl || null;
  let productImageUrl = payload.productImageUrl || null;
  let brollUrl = payload.brollUrl || null;
  let plateUrl = payload.plateUrl || null;
  const ctaText = payload.ctaText || null;
  const kit = payload.kit || (logoUrl || productImageUrl || brollUrl || plateUrl ? "saas_promo" : "text_card");
  const durationSec = Math.min(Math.max(Number(payload.durationSec || 30), 8), 45);
  const edits = payload.edits || {};
  const wantStack = Boolean(edits.stackHalvesTb || payload.stackHalvesTb || payload.brollLayout === "split_tb");
  const wantExport = payload.export !== false; // default export on compose

  // Pull blender plate (and any prior kit fields) from part if remotion was delayed for showroom
  let prevBeats = null;
  let plateSource = payload.plateSource || null;
  let plateTemplate = payload.plateTemplate || null;
  if (partId) {
    try {
      const { rows } = await pool.query(`SELECT preview_props, timeline_json FROM parts WHERE id = $1`, [partId]);
      const prev = rows[0]?.preview_props || {};
      const prevTl = rows[0]?.timeline_json || {};
      prevBeats = payload.beats || prev.beats || prevTl.beats || null;
      plateSource = plateSource || prev.plateSource || null;
      plateTemplate = plateTemplate || prev.plateTemplate || null;
      // Prefer real blender plates under plates/ — ignore stale plateUrl that was a product image
      const prevPlate = prev.plateUrl || null;
      const prevPlateRel = mediaUrlToRel(prevPlate);
      if (!plateUrl && prevPlateRel && String(prevPlateRel).startsWith("plates/")) {
        plateUrl = prevPlate;
      } else if (!plateUrl && prevPlateRel && !prev.productImageUrl) {
        plateUrl = prevPlate;
      }
      // Infer source from path when missing (older parts)
      if (plateUrl && !plateSource) {
        const rel = mediaUrlToRel(plateUrl) || "";
        plateSource = rel.endsWith(".svg") ? "fallback" : rel.startsWith("plates/") ? "cycles" : null;
      }
      logoUrl = logoUrl || prev.logoUrl || null;
      productImageUrl = productImageUrl || prev.productImageUrl || null;
      brollUrl = brollUrl || prev.brollUrl || null;
      if (!payload.audioUrl && prev.audioUrl) payload.audioUrl = prev.audioUrl;
      if (!payload.musicUrl && prev.musicUrl) payload.musicUrl = prev.musicUrl;
      if (!payload.captions && prev.captions) payload.captions = prev.captions;
    } catch (e) {
      console.warn("part preview load failed", e);
    }
  }
  // Use plate as product beat backdrop when no UI screenshot
  if (!productImageUrl && plateUrl) productImageUrl = plateUrl;

  let brollLayout = payload.brollLayout || "full";
  let editOps = [];
  let editedBrollRel = null;
  const brollRel = mediaUrlToRel(brollUrl) || payload.brollPath || null;

  if (brollRel && (wantStack || edits.crop916 || edits.trimStartSec != null || edits.trimEndSec != null)) {
    try {
      const edited = await applyVideoEdits({
        mediaRoot: MEDIA_ROOT,
        inputRel: brollRel,
        jobId,
        stackHalvesTb: wantStack,
        crop916: Boolean(edits.crop916),
        trimStartSec: edits.trimStartSec,
        trimEndSec: edits.trimEndSec,
      });
      if (edited.ops?.length) {
        editOps = edited.ops;
        editedBrollRel = edited.outputRel;
        brollUrl = relToMediaUrl(edited.outputRel);
        brollLayout = "full"; // baked
      }
    } catch (e) {
      console.warn("video edit failed, using live split layout if requested", e);
      if (wantStack) brollLayout = "split_tb";
    }
  } else if (wantStack) {
    brollLayout = "split_tb";
  }

  let exportRel = null;
  const beatDur = (id, fallback) => {
    const b = Array.isArray(prevBeats) ? prevBeats.find((x) => x.id === id || x.type === id) : null;
    const n = Number(b?.durSec);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const exportBeats = {
    logo: beatDur("logo", 2.2),
    product: beatDur("product", 7),
    broll: beatDur("broll", 14),
  };
  if (wantExport && kit === "saas_promo") {
    try {
      const logoRel = mediaUrlToRel(logoUrl);
      const productRel = mediaUrlToRel(productImageUrl);
      const brollForExport = editedBrollRel || brollRel;
      const audioRel = mediaUrlToRel(payload.audioUrl) || payload.audioPath || null;
      const musicRelIn = mediaUrlToRel(payload.musicUrl) || payload.musicPath || null;
      const exported = await exportKitMp4({
        mediaRoot: MEDIA_ROOT,
        jobId,
        titleText,
        subtitle,
        ctaText: ctaText || "Start automating",
        brandName: brandName || "Chatshoot",
        logoAbs: logoRel ? join(MEDIA_ROOT, logoRel) : null,
        productAbs: productRel ? join(MEDIA_ROOT, productRel) : null,
        brollAbs: brollForExport ? join(MEDIA_ROOT, brollForExport) : null,
        audioAbs: audioRel ? join(MEDIA_ROOT, audioRel) : null,
        captions: payload.captions || [],
        durationSec,
        music: payload.music !== false && Boolean(audioRel || payload.kit === "saas_promo"),
        musicAbs: musicRelIn ? join(MEDIA_ROOT, musicRelIn) : null,
        beats: exportBeats,
      });
      exportRel = exported.outputRel;
      if (exported.musicRel) {
        payload.musicUrl = relToMediaUrl(exported.musicRel);
      } else if (musicRelIn) {
        payload.musicUrl = relToMediaUrl(musicRelIn);
      }
      // register as project video asset when we have projectId
      if (job.data.projectId && exportRel) {
        await pool.query(
          `INSERT INTO assets (kind, filename, path, notes, primary_project_id, metadata)
           VALUES ('video', $1, $2, $3, $4, $5)`,
          [
            `${jobId}-export.mp4`,
            exportRel,
            "Exported promo MP4",
            job.data.projectId,
            JSON.stringify({ export: true, kit, editOps }),
          ]
        );
      }
    } catch (e) {
      console.warn("export mp4 failed", e);
    }
  }

  const defaultBeats = [
    { id: "logo", fromSec: 0, durSec: exportBeats.logo, type: "logo" },
    { id: "product", fromSec: exportBeats.logo, durSec: exportBeats.product, type: "product" },
    {
      id: "broll",
      fromSec: exportBeats.logo + exportBeats.product,
      durSec: exportBeats.broll,
      type: "broll",
      layout: brollLayout,
    },
    {
      id: "cta",
      fromSec: exportBeats.logo + exportBeats.product + exportBeats.broll,
      durSec: Math.max(4, durationSec - exportBeats.logo - exportBeats.product - exportBeats.broll),
      type: "cta",
    },
  ];
  const beats =
    Array.isArray(prevBeats) && prevBeats.length
      ? prevBeats.map((b) =>
          b.id === "broll" || b.type === "broll" ? { ...b, layout: b.layout || brollLayout } : b
        )
      : defaultBeats;

  const timelineJson = {
    fps: 30,
    durationSec,
    kit,
    brollLayout,
    editOps,
    beats,
    assets: { logoUrl, productImageUrl, brollUrl, exportUrl: exportRel ? relToMediaUrl(exportRel) : null },
  };

  await mkdir(join(MEDIA_ROOT, "renders"), { recursive: true });
  const rel = `renders/${jobId}-meta.json`;
  await writeFile(join(MEDIA_ROOT, rel), JSON.stringify({ titleText, subtitle, ...timelineJson }, null, 2));

  // Persist timeline on part if we have partId (callback also sets preview)
  if (job.data.partId) {
    try {
      await pool.query(`UPDATE parts SET timeline_json = $1::jsonb, output_path = COALESCE($2, output_path), updated_at = now() WHERE id = $3`, [
        JSON.stringify(timelineJson),
        exportRel,
        job.data.partId,
      ]);
    } catch (e) {
      console.warn("timeline update failed", e);
    }
  }

  const editLabel = editOps.length ? ` edit:${editOps.join("+")}` : brollLayout === "split_tb" ? " edit:split_tb(live)" : "";
  await callback({
    jobId,
    status: "completed",
    previewProps: {
      titleText,
      subtitle,
      bg: "#0b1220",
      accent: "#3dd6c6",
      plateUrl: plateUrl || null,
      plateSource: plateSource || null,
      plateTemplate: plateTemplate || null,
      brandName,
      logoUrl,
      productImageUrl,
      brollUrl,
      brollLayout,
      ctaText,
      kit,
      durationSec,
      beats,
      exportUrl: exportRel ? relToMediaUrl(exportRel) : null,
      ...(payload.audioUrl ? { audioUrl: payload.audioUrl } : {}),
      ...(payload.captions ? { captions: payload.captions } : {}),
      ...(payload.musicUrl ? { musicUrl: payload.musicUrl } : {}),
    },
    lastChangeSummary:
      kit === "saas_promo"
        ? `SaaS kit ${durationSec}s${editLabel}: ${[logoUrl && "logo", productImageUrl && "UI", plateUrl && "plate", brollUrl && "b-roll"].filter(Boolean).join("+") || "assets"} · ${titleText}${exportRel ? " · exported" : ""}${payload.audioUrl ? " · with VO" : ""}${payload.musicUrl ? " · music" : ""}`
        : `Remotion compose: ${titleText}`,
    result: { metaPath: rel, kit, durationSec, editOps, exportRel, timelineJson },
    settle: { provider: "openai", unitKind: "token", units: 200 },
  });
}

new Worker(
  "remotion",
  async (job) => {
    console.log("remotion job", job.id, job.data.kind);
    await handleRemotion(job);
  },
  { connection }
);

console.log("worker-remotion listening");
