import { Worker } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { applyVideoEdits, exportKitMp4, exportTimelineMp4 } from "./edit.js";
import { buildTimelineV2 } from "./timelineV2.js";

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
    let editedStillUrl = null;
    let usedModel = payload.modelSlug || payload.model || null;
    let usedVersion = payload.modelVersion || null;
    const pipeline = Array.isArray(payload.pipeline) ? payload.pipeline : null;
    const pipelineLog = [];

    async function resolveVersion(slug) {
      if (!slug) return null;
      if (/^[0-9a-f]{64}$/i.test(slug) || (slug.length > 60 && !slug.includes("/"))) return slug;
      if (!slug.includes("/")) return slug;
      const [owner, name] = slug.split("/");
      const meta = await fetch(`https://api.replicate.com/v1/models/${owner}/${name}`, {
        headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` },
        signal: AbortSignal.timeout(15000),
      });
      const metaData = await meta.json();
      return metaData.latest_version?.id || null;
    }

    async function runPrediction(version, input) {
      const res = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: {
          Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ version, input }),
      });
      const data = await res.json();
      let out = data.output;
      if (Array.isArray(out)) out = out[0] || null;
      return { out, data };
    }

    if (process.env.REPLICATE_API_TOKEN && !payload.mockOnly) {
      try {
        if (pipeline?.length) {
          let imageUrl = (payload.refImageUrls && payload.refImageUrls[0]) || payload.imageUrl || null;
          for (const step of pipeline) {
            const slug = step.modelSlug || usedModel;
            const ver = await resolveVersion(slug);
            if (!ver) {
              pipelineLog.push({ slug, skipped: "no version" });
              continue;
            }
            const cat = step.category || "image_to_video";
            let input = { ...(step.input || {}) };
            if (cat === "image_edit") {
              input = {
                prompt: step.prompt || payload.prompt || "same person, new wardrobe and pose",
                input_image: imageUrl,
                ...input,
              };
            } else if (cat === "upscale") {
              input = { image: imageUrl, ...input };
            } else if (cat === "image_to_video" || cat === "text_to_video") {
              input = {
                prompt: step.prompt || payload.prompt || "cinematic product shot",
                duration: Math.min(Number(step.durationSec || durationSec), 5),
                ...(imageUrl ? { start_image: imageUrl, image: imageUrl } : {}),
                ...input,
              };
            } else if (cat === "lip_sync") {
              input = { source_image: imageUrl, ...input };
            }
            const { out } = await runPrediction(ver, input);
            pipelineLog.push({ slug, category: cat, ok: Boolean(out) });
            if (out && (cat === "image_edit" || cat === "upscale")) {
              editedStillUrl = out;
              imageUrl = out;
            } else if (out) {
              outputUrl = out;
              usedModel = slug;
              usedVersion = ver;
            }
          }
        } else {
          if (!usedVersion) {
            const slug = usedModel || "kwaivgi/kling-v2.5-turbo-pro";
            usedModel = slug;
            usedVersion = await resolveVersion(slug);
          }
          if (!usedVersion) usedVersion = process.env.REPLICATE_MODEL_VERSION || null;
          if (usedVersion) {
            const ref = (payload.refImageUrls && payload.refImageUrls[0]) || null;
            const { out } = await runPrediction(usedVersion, {
              prompt: payload.prompt || "cinematic product shot",
              duration: durationSec,
              ...(ref ? { start_image: ref, image: ref } : {}),
              ...(payload.input || {}),
            });
            outputUrl = out;
          }
        }
      } catch (e) {
        console.warn("replicate call failed, using mock", e);
      }
    }

    // Persist clip locally when we have a remote URL
    await mkdir(join(MEDIA_ROOT, "genfill"), { recursive: true });
    await mkdir(join(MEDIA_ROOT, "renders"), { recursive: true });
    let localRel = null;
    if (outputUrl && String(outputUrl).startsWith("http")) {
      try {
        const bin = await fetch(outputUrl, { signal: AbortSignal.timeout(30000) });
        if (bin.ok) {
          const ext = /\.webm/i.test(outputUrl) ? "webm" : "mp4";
          localRel = `genfill/${jobId}.${ext}`;
          await writeFile(join(MEDIA_ROOT, localRel), Buffer.from(await bin.arrayBuffer()));
          outputUrl = `/api/media?path=${encodeURIComponent(localRel)}`;
        }
      } catch (e) {
        console.warn("genfill download failed", e);
      }
    }

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
          editedStillUrl,
          pipelineLog,
          localRel,
          personaId: payload.personaId || null,
        },
        null,
        2
      )
    );

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
        pipeline: pipelineLog,
        personaId: payload.personaId || null,
        editedStillUrl,
      },
    };
    // Only wire genfill into kit b-roll when already on SaaS kit; freeform uses insertGenfillClip
    if (genfillUrl && partPrev.kit === "saas_promo" && !partPrev.brollUrl) {
      previewProps.brollUrl = genfillUrl;
    }

    await callback({
      jobId,
      status: "completed",
      previewProps,
      lastChangeSummary: `GenFill ${durationSec}s (${usedModel || "mock"})${pipeline ? " · pipeline" : ""}${genfillUrl ? " · fused" : " · mock marker only"}`,
      result: { path: rel, outputUrl, model: usedModel, version: usedVersion, pipelineLog, localRel },
      settle: {
        provider: "replicate",
        unitKind: "second",
        units: durationSec * Math.max(1, pipeline?.length || 1),
      },
      insertGenfillClip: Boolean(payload.insertTimelineClip && genfillUrl),
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
  // Never invent saas_promo from assets — kit only when payload explicitly sets it
  const kit = payload.kit === "saas_promo" ? "saas_promo" : payload.kit ?? null;
  const isKit = kit === "saas_promo";
  const durationSec = Math.min(Math.max(Number(payload.durationSec || 30), 8), 45);
  const edits = payload.edits || {};
  const wantStack = Boolean(edits.stackHalvesTb || payload.stackHalvesTb || payload.brollLayout === "split_tb");
  const wantExport = payload.export !== false; // default export on compose

  // Pull blender plate (and any prior kit fields) from part if remotion was delayed for showroom
  let prevBeats = null;
  let prevTimeline = payload.timeline || null;
  let plateSource = payload.plateSource || null;
  let plateTemplate = payload.plateTemplate || null;
  if (partId) {
    try {
      const { rows } = await pool.query(`SELECT preview_props, timeline_json FROM parts WHERE id = $1`, [partId]);
      const prev = rows[0]?.preview_props || {};
      const prevTl = rows[0]?.timeline_json || {};
      if (!prevTimeline && prevTl?.version === 2) prevTimeline = prevTl;
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
  // Kit only: use plate as product beat backdrop when no UI screenshot
  if (isKit && !productImageUrl && plateUrl) productImageUrl = plateUrl;

  let brollLayout = payload.brollLayout || "full";
  let editOps = [];
  let editedBrollRel = null;
  const brollRel = mediaUrlToRel(brollUrl) || payload.brollPath || null;

  // Freeform V1 clips from payload (may be rewritten after ffmpeg edits)
  let workingTimeline =
    prevTimeline && prevTimeline.version === 2 && Array.isArray(prevTimeline.tracks)
      ? {
          ...prevTimeline,
          tracks: prevTimeline.tracks.map((t) => ({
            ...t,
            clips: (t.clips || []).map((c) => ({
              ...c,
              assetRef: c.assetRef ? { ...c.assetRef } : c.assetRef,
            })),
          })),
        }
      : prevTimeline;

  const wantClipEdits =
    wantStack || edits.crop916 || edits.trimStartSec != null || edits.trimEndSec != null;

  if (brollRel && wantClipEdits && isKit) {
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
  } else if (wantStack && isKit) {
    brollLayout = "split_tb";
  }

  // Freeform: apply the same ffmpeg edits to video clips on V1 (not plates/stills)
  if (!isKit && wantClipEdits && workingTimeline?.tracks) {
    const v1 = workingTimeline.tracks.find((t) => t.id === "V1" || t.kind === "video");
    if (v1?.clips?.length) {
      const nextClips = [];
      for (const c of v1.clips) {
        const role = String(c.role || "");
        const url = c.assetRef?.url || null;
        const path = c.assetRef?.path || mediaUrlToRel(url);
        const isVid =
          (path && /\.(mp4|webm|mov)$/i.test(path)) ||
          (url && /\.(mp4|webm|mov)(\?|$)/i.test(url));
        if (!isVid || role === "plate" || !path) {
          nextClips.push(c);
          continue;
        }
        try {
          const edited = await applyVideoEdits({
            mediaRoot: MEDIA_ROOT,
            inputRel: path,
            jobId: `${jobId}-${c.id || "clip"}`,
            stackHalvesTb: wantStack,
            crop916: Boolean(edits.crop916),
            trimStartSec: edits.trimStartSec,
            trimEndSec: edits.trimEndSec,
          });
          if (edited.ops?.length && edited.outputRel) {
            editOps = [...new Set([...editOps, ...edited.ops])];
            editedBrollRel = editedBrollRel || edited.outputRel;
            nextClips.push({
              ...c,
              assetRef: {
                ...(c.assetRef || {}),
                path: edited.outputRel,
                url: relToMediaUrl(edited.outputRel),
                slot: undefined,
              },
              transform: { ...(c.transform || {}), layout: "full" },
            });
          } else {
            nextClips.push(c);
          }
        } catch (e) {
          console.warn("freeform clip edit failed", c.id, e);
          nextClips.push(
            wantStack
              ? { ...c, transform: { ...(c.transform || {}), layout: "split_tb" } }
              : c
          );
        }
      }
      workingTimeline = {
        ...workingTimeline,
        tracks: workingTimeline.tracks.map((t) =>
          t.id === v1.id || (t.kind === "video" && t === v1) ? { ...v1, clips: nextClips } : t
        ),
        editOps,
        beats: nextClips.map((c, i) => ({
          id: c.role || c.id || `clip_${i}`,
          fromSec: c.fromSec,
          durSec: c.durSec,
          type: c.role || "clip",
        })),
      };
      prevTimeline = workingTimeline;
    }
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

  const payloadClips =
    (prevTimeline?.tracks || []).find((t) => t.id === "V1" || t.kind === "video")?.clips || [];

  // Build CapCut timeline before export so freeform clips drive both preview and MP4
  const timelineJson = buildTimelineV2({
    durationSec,
    kit,
    beats: isKit ? prevBeats : null,
    clips: !isKit && payloadClips.length ? payloadClips : null,
    brollLayout,
    editOps,
    assets: {
      logoUrl,
      productImageUrl,
      brollUrl,
      plateUrl,
      genfillUrl: payload.genfillUrl || null,
    },
    audioUrl: payload.audioUrl || null,
    musicUrl: payload.musicUrl || null,
  });
  const finalTimeline = (() => {
    const prevV1 =
      (prevTimeline?.tracks || []).find((t) => t.id === "V1" || t.kind === "video")?.clips || [];
    if (prevTimeline && prevTimeline.version === 2 && prevV1.length) {
      return {
        ...prevTimeline,
        kit: isKit ? "saas_promo" : prevTimeline.kit ?? null,
        beats: prevTimeline.beats?.length ? prevTimeline.beats : timelineJson.beats,
        assets: { ...timelineJson.assets, ...(prevTimeline.assets || {}) },
      };
    }
    return timelineJson;
  })();

  const beats = finalTimeline.beats || [];

  if (wantExport) {
    try {
      const logoRel = mediaUrlToRel(logoUrl);
      const productRel = mediaUrlToRel(productImageUrl);
      const brollForExport = editedBrollRel || brollRel;
      const audioRel = mediaUrlToRel(payload.audioUrl) || payload.audioPath || null;
      const musicRelIn = mediaUrlToRel(payload.musicUrl) || payload.musicPath || null;
      const tlClips =
        (finalTimeline.tracks || []).find((t) => t.id === "V1" || t.kind === "video")?.clips || [];
      const resolveAbs = (c) => {
        const url =
          c.assetRef?.url ||
          (c.assetRef?.slot === "logoUrl" ? logoUrl : null) ||
          (c.assetRef?.slot === "productImageUrl" ? productImageUrl : null) ||
          (c.assetRef?.slot === "brollUrl" ? brollUrl : null) ||
          (c.assetRef?.slot === "plateUrl" ? plateUrl : null) ||
          (c.assetRef?.path ? `/api/media?path=${encodeURIComponent(c.assetRef.path)}` : null);
        const rel = mediaUrlToRel(url) || c.assetRef?.path || null;
        return rel ? join(MEDIA_ROOT, rel) : null;
      };
      const exported =
        isKit
          ? await exportKitMp4({
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
              music: payload.music !== false && Boolean(audioRel || isKit),
              musicAbs: musicRelIn ? join(MEDIA_ROOT, musicRelIn) : null,
              beats: exportBeats,
            })
          : tlClips.length
            ? await exportTimelineMp4({
                mediaRoot: MEDIA_ROOT,
                jobId,
                clips: tlClips.map((c) => ({
                  ...c,
                  absPath: resolveAbs(c),
                })),
                audioAbs: audioRel ? join(MEDIA_ROOT, audioRel) : null,
                musicAbs: musicRelIn ? join(MEDIA_ROOT, musicRelIn) : null,
                durationSec,
                titleText,
                subtitle,
                ctaText: ctaText || null,
                brandName: brandName || null,
                captions: payload.captions || [],
                kitAssets: {
                  logoAbs: logoRel ? join(MEDIA_ROOT, logoRel) : null,
                  productAbs: productRel ? join(MEDIA_ROOT, productRel) : null,
                  brollAbs: brollForExport ? join(MEDIA_ROOT, brollForExport) : null,
                },
              })
            : null;
      if (exported) {
        exportRel = exported.outputRel;
        if (exported.musicRel) {
          payload.musicUrl = relToMediaUrl(exported.musicRel);
        } else if (musicRelIn) {
          payload.musicUrl = relToMediaUrl(musicRelIn);
        }
        if (job.data.projectId && exportRel) {
          await pool.query(
            `INSERT INTO assets (kind, filename, path, notes, primary_project_id, metadata)
             VALUES ('video', $1, $2, $3, $4, $5)`,
            [
              `${jobId}-export.mp4`,
              exportRel,
              "Exported timeline MP4",
              job.data.projectId,
              JSON.stringify({ export: true, kit, editOps, publishedToGallery: false }),
            ]
          );
        }
      }
    } catch (e) {
      console.warn("export mp4 failed", e);
    }
  }

  if (exportRel) {
    finalTimeline.assets = {
      ...(finalTimeline.assets || {}),
      exportUrl: relToMediaUrl(exportRel),
    };
  }

  await mkdir(join(MEDIA_ROOT, "renders"), { recursive: true });
  const rel = `renders/${jobId}-meta.json`;
  await writeFile(join(MEDIA_ROOT, rel), JSON.stringify({ titleText, subtitle, ...finalTimeline }, null, 2));

  // Persist timeline on part if we have partId (callback also sets preview)
  if (job.data.partId) {
    try {
      await pool.query(`UPDATE parts SET timeline_json = $1::jsonb, output_path = COALESCE($2, output_path), updated_at = now() WHERE id = $3`, [
        JSON.stringify(finalTimeline),
        exportRel,
        job.data.partId,
      ]);
    } catch (e) {
      console.warn("timeline update failed", e);
    }
  }

  const clipCount =
    (finalTimeline.tracks || []).find((t) => t.id === "V1" || t.kind === "video")?.clips?.length || 0;
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
      logoUrl: logoUrl,
      productImageUrl: productImageUrl,
      brollUrl: brollUrl,
      brollLayout,
      ctaText,
      kit,
      durationSec: finalTimeline.durationSec || durationSec,
      beats,
      timeline: finalTimeline,
      exportUrl: exportRel ? relToMediaUrl(exportRel) : null,
      ...(payload.audioUrl ? { audioUrl: payload.audioUrl } : {}),
      ...(payload.captions ? { captions: payload.captions } : {}),
      ...(payload.musicUrl ? { musicUrl: payload.musicUrl } : {}),
    },
    lastChangeSummary: isKit
      ? `SaaS kit ${durationSec}s${editLabel}: ${[logoUrl && "logo", productImageUrl && "UI", plateUrl && "plate", brollUrl && "b-roll"].filter(Boolean).join("+") || "assets"} · ${titleText}${exportRel ? " · exported" : ""}${payload.audioUrl ? " · with VO" : ""}${payload.musicUrl ? " · music" : ""}`
      : `Freeform ${clipCount} clips${editLabel} · ${titleText}${exportRel ? " · exported" : ""}${payload.audioUrl ? " · with VO" : ""}`,
    result: { metaPath: rel, kit, durationSec, editOps, exportRel, timelineJson: finalTimeline },
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
