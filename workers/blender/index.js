import { Worker } from "bullmq";
import IORedis from "ioredis";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
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

function runBlender(scriptPath, outPng) {
  return new Promise((resolve) => {
    const blender = process.env.BLENDER_BIN || "blender";
    if (!existsSync(scriptPath)) {
      resolve({ ok: false, reason: `no script: ${scriptPath}` });
      return;
    }
    const args = ["-b", "-P", scriptPath, "--", outPng];
    if (process.env.BLENDER_USE_GPU === "1") {
      args.splice(1, 0, "--python-expr", "import os; os.environ['BLENDER_USE_GPU']='1'");
    }
    const child = spawn(blender, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (e) => resolve({ ok: false, reason: e.message || "blender missing" }));
    child.on("close", (code) => {
      const wrote = existsSync(outPng);
      resolve({
        ok: code === 0 && wrote,
        reason: code === 0 && !wrote ? "render wrote no file" : code !== 0 ? `exit ${code}: ${stderr.slice(-400)}` : undefined,
      });
    });
  });
}

async function renderPlate(job) {
  const { jobId, payload = {} } = job.data;
  const template = ["showroom", "cafe"].includes(payload.template) ? payload.template : "showroom";
  await mkdir(join(MEDIA_ROOT, "plates"), { recursive: true });
  const outRel = `plates/${template}-${jobId}.png`;
  const outAbs = join(MEDIA_ROOT, outRel);
  // Always resolve scripts next to this worker — not process.cwd()
  const script = join(__dirname, "scripts", `${template}.py`);

  console.log("blender render", template, script, "→", outAbs);
  const result = await runBlender(script, outAbs);
  if (!result.ok) {
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
      },
      lastChangeSummary: `Blender ${template} plate (fallback)`,
      result: { platePath: svgRel, blender: false, reason: result.reason, plateSource: "fallback" },
    });
    return;
  }

  await callback({
    jobId,
    status: "completed",
    previewProps: {
      plateUrl: `/api/media?path=${encodeURIComponent(outRel)}`,
      plateSource: "cycles",
      plateTemplate: template,
    },
    lastChangeSummary: `Blender ${template} plate (Cycles)`,
    result: { platePath: outRel, blender: true, plateSource: "cycles" },
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
