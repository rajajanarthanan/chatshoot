import { Worker } from "bullmq";
import IORedis from "ioredis";
import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const MEDIA_ROOT = process.env.MEDIA_ROOT || join(__dirname, "../../media");
const WEB_CALLBACK =
  process.env.WEB_CALLBACK_URL || "http://web:3000/api/workers/callback";
const WEB_CALLBACK_LOCAL =
  process.env.WEB_CALLBACK_LOCAL || "http://localhost:2980/api/workers/callback";

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

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
      /* */
    }
  }
}

function resolveMedia(p) {
  if (!p) return null;
  if (isAbsolute(p) && existsSync(p)) return p;
  const rel = String(p).replace(/^\/api\/media\?path=/, "");
  try {
    const decoded = decodeURIComponent(rel);
    const abs = join(MEDIA_ROOT, decoded);
    return existsSync(abs) ? abs : abs;
  } catch {
    return join(MEDIA_ROOT, rel);
  }
}

function stillFromVideo(abs) {
  if (!abs || !/\.(mp4|webm|mov)$/i.test(abs) || !existsSync(abs)) return abs;
  const out = abs.replace(/\.[^.]+$/, "") + "-frame.png";
  if (existsSync(out)) return out;
  const r = spawnSync("ffmpeg", ["-y", "-ss", "0.2", "-i", abs, "-frames:v", "1", out], {
    stdio: "ignore",
  });
  return r.status === 0 && existsSync(out) ? out : abs;
}

function runBlender(scriptPath, args) {
  return new Promise((resolve) => {
    const blender = process.env.BLENDER_BIN || "blender";
    if (!existsSync(scriptPath)) {
      resolve({ ok: false, reason: `no script: ${scriptPath}` });
      return;
    }
    const spawnArgs = ["-b", "-P", scriptPath, "--", ...args];
    if (process.env.BLENDER_USE_GPU === "1") {
      spawnArgs.splice(1, 0, "--python-expr", "import os; os.environ['BLENDER_USE_GPU']='1'");
    }
    const child = spawn(blender, spawnArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (e) => resolve({ ok: false, reason: e.message || "blender missing" }));
    child.on("close", (code) => {
      const outPng = args[0];
      const moveMp4 = String(outPng || "").replace(/\.png$/i, ".mp4");
      const wrote = existsSync(outPng) || (moveMp4 !== outPng && existsSync(moveMp4));
      resolve({
        ok: code === 0 && wrote,
        reason:
          code === 0 && !wrote
            ? "render wrote no file"
            : code !== 0
              ? `exit ${code}: ${stderr.slice(-400)}`
              : undefined,
      });
    });
  });
}

async function renderPlate(job) {
  const { jobId, payload = {} } = job.data;
  const wantAssemble =
    payload.assemble === true ||
    payload.template === "assemble" ||
    Boolean(payload.hdri || payload.assetPaths?.hdri);
  const template = wantAssemble
    ? "assemble"
    : ["showroom", "cafe"].includes(payload.template)
      ? payload.template
      : "showroom";

  await mkdir(join(MEDIA_ROOT, "plates"), { recursive: true });
  const outRel = `plates/${template}-${jobId}.png`;
  const outAbs = join(MEDIA_ROOT, outRel);

  let result;
  if (template === "assemble") {
    const cfg = {
      hdri: resolveMedia(payload.hdri || payload.assetPaths?.hdri),
      props: (payload.props || payload.assetPaths?.props || [])
        .map(resolveMedia)
        .filter(Boolean),
      planeImage: resolveMedia(payload.planeImage || payload.assetPaths?.planeImage),
      planeImages: (
        payload.planeImages ||
        payload.assetPaths?.planeImages ||
        []
      )
        .map(resolveMedia)
        .filter(Boolean),
      camera: payload.camera || null,
      lights: payload.lights || [],
      objects: (payload.objects || []).map((o) => ({
        ...o,
        path: stillFromVideo(resolveMedia(o.path)),
      })),
      void: Boolean(payload.void),
      samples: payload.camera?.track?.length > 1 ? Math.min(payload.samples || 16, 12) : payload.samples || 32,
      frames: Number(payload.frames || 1),
    };
    const cfgRel = `plates/assemble-cfg-${jobId}.json`;
    const cfgAbs = join(MEDIA_ROOT, cfgRel);
    await writeFile(cfgAbs, JSON.stringify(cfg, null, 2));
    const script = join(__dirname, "scripts", "assemble.py");
    console.log("blender assemble", cfg, "→", outAbs);
    result = await runBlender(script, [outAbs, cfgAbs]);
    // If assemble failed (no HDRI / no blender), fall back to showroom procedural
    if (!result.ok && !payload.void) {
      console.warn("assemble failed, trying showroom:", result.reason);
      const showroom = join(__dirname, "scripts", "showroom.py");
      result = await runBlender(showroom, [outAbs]);
    }
  } else {
    const script = join(__dirname, "scripts", `${template}.py`);
    console.log("blender render", template, script, "→", outAbs);
    result = await runBlender(script, [outAbs]);
  }

  if (!result.ok && !existsSync(outAbs.replace(/\.png$/i, ".mp4"))) {
    console.warn("blender failed, SVG fallback:", result.reason);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1e293b"/><stop offset="100%" stop-color="#0ea5e9"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <text x="540" y="900" fill="#e2e8f0" font-size="48" text-anchor="middle" font-family="sans-serif">${template} plate</text>
      <text x="540" y="980" fill="#94a3b8" font-size="28" text-anchor="middle">video plane A · hero · plane B</text>
      <text x="540" y="1040" fill="#64748b" font-size="22" text-anchor="middle">fallback (blender unavailable)</text>
    </svg>`;
    const svgRel = outRel.replace(/\.png$/, ".svg");
    await writeFile(join(MEDIA_ROOT, svgRel), svg);
    await callback({
      jobId,
      status: "completed",
      previewProps: {
        plateUrl: `/api/media?path=${encodeURIComponent(svgRel)}`,
        plateSource: "fallback",
        plateTemplate: template,
        environmentId: payload.environmentId || null,
      },
      lastChangeSummary: `Blender ${template} plate (fallback)`,
      result: {
        platePath: svgRel,
        blender: false,
        reason: result.reason,
        plateSource: "fallback",
        environmentId: payload.environmentId || null,
      },
      insertPlateClip: true,
    });
    return;
  }

  const track = payload.camera?.track || [];
  const trackDur = track.length >= 2 ? Number(track[track.length - 1]?.t || 0) : 0;
  const frames = Number(payload.frames) > 1
    ? Number(payload.frames)
    : trackDur > 0.2
      ? Math.max(2, Math.min(48, Math.round(trackDur * 12)))
      : 1;
  const moveMp4 = outAbs.replace(/\.png$/i, ".mp4");
  const renderedMove = existsSync(moveMp4) && (frames > 1 || !existsSync(outAbs));
  const plateRel = renderedMove ? outRel.replace(/\.png$/i, ".mp4") : outRel;

  await callback({
    jobId,
    status: "completed",
    previewProps: {
      plateUrl: `/api/media?path=${encodeURIComponent(plateRel)}`,
      videoUrl: renderedMove ? `/api/media?path=${encodeURIComponent(plateRel)}` : null,
      plateSource: "cycles",
      plateTemplate: template,
      environmentId: payload.environmentId || null,
      cameraMoveSec: renderedMove ? frames / 12 : null,
    },
    lastChangeSummary: renderedMove ? `Camera move ${frames} frames` : `Blender ${template} plate (Cycles)`,
    result: {
      platePath: plateRel,
      videoPath: renderedMove ? plateRel : null,
      blender: true,
      plateSource: "cycles",
      environmentId: payload.environmentId || null,
    },
    insertPlateClip: true,
    insertVideoClip: renderedMove,
  });
}

new Worker(
  "blender",
  async (job) => {
    console.log("blender job", job.id);
    await renderPlate(job);
  },
  { connection }
);

console.log("worker-blender listening (scripts:", join(__dirname, "scripts"), "; set BLENDER_USE_GPU=1 when available)");
