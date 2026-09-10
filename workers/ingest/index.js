import { Worker } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";
import { readFile, writeFile, mkdir } from "fs/promises";
import { basename, join } from "path";
import { Blob } from "buffer";

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

async function getArmManagementToken() {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  const azBin = process.env.AZURE_CLI_PATH || "az";
  const { stdout } = await execFileAsync(
    azBin,
    ["account", "get-access-token", "--resource", "https://management.azure.com/", "--query", "accessToken", "-o", "tsv"],
    { env: process.env, maxBuffer: 2 * 1024 * 1024 }
  );
  const token = String(stdout || "").trim();
  if (!token) throw new Error("az returned empty management token — run az login");
  return token;
}

async function getVideoIndexerAccessToken() {
  const accountId = process.env.AZURE_VIDEO_INDEXER_ACCOUNT_ID;
  const location = process.env.AZURE_VIDEO_INDEXER_LOCATION || "eastus";
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const resourceGroup = process.env.AZURE_RESOURCE_GROUP;
  const accountName = process.env.AZURE_VIDEO_INDEXER_ACCOUNT_NAME;
  const classicKey = (process.env.AZURE_VIDEO_INDEXER_SUBSCRIPTION_KEY || "").trim();

  // Prefer ARM generateAccessToken for portal-created (paid/ARM) accounts.
  if (subscriptionId && resourceGroup && accountName) {
    const aad = await getArmManagementToken();
    const url =
      `https://management.azure.com/subscriptions/${subscriptionId}` +
      `/resourceGroups/${resourceGroup}/providers/Microsoft.VideoIndexer` +
      `/accounts/${accountName}/generateAccessToken?api-version=2025-04-01`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aad}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permissionType: "Contributor", scope: "Account" }),
    });
    const raw = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const accessToken = parsed?.accessToken || parsed?.AccessToken;
    if (!res.ok || !accessToken) {
      throw new Error(`ARM generateAccessToken failed (${res.status}): ${raw.slice(0, 400)}`);
    }
    return { token: accessToken, location, accountId, auth: "arm" };
  }

  // Classic / trial path only (api-portal subscription key).
  if (accountId && classicKey) {
    const tokenRes = await fetch(
      `https://api.videoindexer.ai/auth/${location}/Accounts/${accountId}/AccessToken?allowEdit=true`,
      { headers: { "Ocp-Apim-Subscription-Key": classicKey } }
    );
    const tokenRaw = await tokenRes.text();
    const token = tokenRaw.replace(/^"|"$/g, "");
    if (!tokenRes.ok) {
      throw new Error(`Classic AccessToken failed (${tokenRes.status}): ${tokenRaw.slice(0, 300)}`);
    }
    return { token, location, accountId, auth: "classic" };
  }

  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractInsights(index) {
  const video = index?.videos?.[0] || {};
  const insights = video.insights || {};
  const transcriptParts = (insights.transcript || [])
    .map((t) => (t.text || "").trim())
    .filter(Boolean);
  const transcript = transcriptParts.join(" ").trim();
  const labels = [
    ...(insights.labels || []).map((l) => l.name).filter(Boolean),
    ...(insights.topics || []).map((t) => t.name).filter(Boolean),
    ...(insights.keywords || []).map((k) => k.text || k.name).filter(Boolean),
    ...(insights.ocr || []).map((o) => o.text).filter(Boolean).slice(0, 10),
    ...(insights.brands || []).map((b) => b.name).filter(Boolean),
  ].slice(0, 40);
  const scenes = (insights.scenes || []).map((s, i) => ({
    start: s.instances?.[0]?.start || s.start || null,
    end: s.instances?.[0]?.end || s.end || null,
    label: s.id != null ? `scene_${s.id}` : `scene_${i}`,
  }));
  const shots = (insights.shots || []).slice(0, 20).map((s, i) => ({
    start: s.instances?.[0]?.start || null,
    end: s.instances?.[0]?.end || null,
    label: `shot_${i}`,
  }));
  return {
    transcript: transcript || (labels.length ? `Visual: ${labels.slice(0, 12).join(", ")}` : ""),
    labels: [...new Set(labels)],
    scenes: scenes.length ? scenes : shots,
    durationSec: index?.durationInSeconds || video.durationInSeconds || null,
  };
}

async function uploadAndIndexVideo(auth, absPath, filename) {
  if (!auth.accountId) {
    throw new Error("AZURE_VIDEO_INDEXER_ACCOUNT_ID is required for upload");
  }
  const bytes = await readFile(absPath);
  if (!bytes.length) throw new Error("empty video file");

  const name = basename(filename || absPath).replace(/\.[^.]+$/, "") || `chatshoot-${Date.now()}`;

  const uploadUrl =
    `https://api.videoindexer.ai/${auth.location}/Accounts/${auth.accountId}/Videos?` +
    new URLSearchParams({
      name,
      privacy: "Private",
      indexingPreset: "Default",
      streamingPreset: "NoStreaming",
      language: "en-US",
      accessToken: auth.token,
    }).toString();

  let videoId = null;
  let lastState = "Uploaded";
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Rebuild FormData each attempt — body stream can only be consumed once
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: "video/mp4" }),
      basename(filename || absPath) || "upload.mp4"
    );
    const uploadRes = await fetch(uploadUrl, { method: "POST", body: form });
    const uploadRaw = await uploadRes.text();
    let uploaded;
    try {
      uploaded = JSON.parse(uploadRaw);
    } catch {
      uploaded = null;
    }
    if (uploadRes.ok && uploaded?.id) {
      videoId = uploaded.id;
      lastState = uploaded.state || "Uploaded";
      break;
    }
    lastErr = `Upload failed (${uploadRes.status}): ${uploadRaw.slice(0, 400)}`;
    if (attempt < 3) await sleep(2000 * attempt);
  }
  if (!videoId) throw new Error(lastErr || "Upload failed");

  const maxWaitMs = Number(process.env.AZURE_VI_MAX_WAIT_MS || 8 * 60 * 1000);
  const started = Date.now();
  let delay = 5000;
  let index = null;

  while (Date.now() - started < maxWaitMs) {
    await sleep(delay);
    // Refresh VI token periodically (ARM JWT ~1h; keep fresh for long indexes)
    let token = auth.token;
    if (Date.now() - started > 50 * 60 * 1000) {
      const refreshed = await getVideoIndexerAccessToken();
      if (refreshed?.token) token = refreshed.token;
    }
    const indexUrl =
      `https://api.videoindexer.ai/${auth.location}/Accounts/${auth.accountId}/Videos/${videoId}/Index?` +
      new URLSearchParams({ accessToken: token, language: "en-US" }).toString();
    const indexRes = await fetch(indexUrl);
    const indexRaw = await indexRes.text();
    try {
      index = JSON.parse(indexRaw);
    } catch {
      throw new Error(`Get Index invalid JSON (${indexRes.status}): ${indexRaw.slice(0, 300)}`);
    }
    if (!indexRes.ok) {
      throw new Error(`Get Index failed (${indexRes.status}): ${indexRaw.slice(0, 400)}`);
    }
    lastState = index.state || lastState;
    if (lastState === "Processed") break;
    if (lastState === "Failed" || lastState === "Quarantined") {
      throw new Error(`Indexing ${lastState}: ${index.failureMessage || index.videos?.[0]?.processingProgress || ""}`.slice(0, 400));
    }
    delay = Math.min(delay + 2000, 20000);
  }

  if (lastState !== "Processed") {
    throw new Error(`Indexing timed out after ${maxWaitMs}ms (last state=${lastState}, videoId=${videoId})`);
  }

  const extracted = extractInsights(index);
  return {
    mock: false,
    tokenOk: true,
    auth: auth.auth,
    location: auth.location,
    accountId: auth.accountId,
    videoId,
    state: lastState,
    ...extracted,
    transcript:
      extracted.transcript ||
      `Indexed ${name} (no speech transcript; labels: ${(extracted.labels || []).slice(0, 8).join(", ") || "none"})`,
  };
}

async function azureUnderstand(absPath, filename) {
  let auth;
  try {
    auth = await getVideoIndexerAccessToken();
  } catch (err) {
    return {
      mock: true,
      error: String(err?.message || err).slice(0, 400),
      transcript: `Azure auth failed for ${filename}; falling back to mock.`,
      scenes: [],
      labels: ["azure_auth_failed"],
    };
  }
  if (!auth) {
    return {
      mock: true,
      transcript: `Mock transcript for ${filename}: product showcase, indoor lighting, camera pans left to right.`,
      scenes: [
        { start: 0, end: 3, label: "establishing" },
        { start: 3, end: 8, label: "product closeup" },
      ],
      labels: ["product", "indoor", "retail"],
    };
  }
  try {
    return await uploadAndIndexVideo(auth, absPath, filename);
  } catch (err) {
    return {
      mock: true,
      tokenOk: true,
      auth: auth.auth,
      location: auth.location,
      accountId: auth.accountId,
      error: String(err?.message || err).slice(0, 500),
      transcript: `Azure upload/index failed for ${filename}; falling back to mock.`,
      scenes: [],
      labels: ["azure_upload_failed"],
    };
  }
}

async function embedText(text) {
  if (!process.env.OPENAI_API_KEY) return null;
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
  });
  const data = await res.json();
  return data.data?.[0]?.embedding || null;
}

async function crawl(payload) {
  const query = payload.query || payload.url;
  if (payload.url && process.env.FIRECRAWL_API_KEY) {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: payload.url }),
    });
    const data = await res.json();
    await mkdir(join(MEDIA_ROOT, "crawl"), { recursive: true });
    const rel = `crawl/${Date.now()}.json`;
    await writeFile(join(MEDIA_ROOT, rel), JSON.stringify(data, null, 2));
    return { path: rel, provider: "firecrawl" };
  }
  if (query && process.env.BRIGHTDATA_API_KEY && process.env.BRIGHTDATA_SERP_ZONE) {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&brd_json=1`;
    const res = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        zone: process.env.BRIGHTDATA_SERP_ZONE,
        url: searchUrl,
        format: "raw",
      }),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 50000), status: res.status };
    }
    await mkdir(join(MEDIA_ROOT, "crawl"), { recursive: true });
    const rel = `crawl/brightdata-${Date.now()}.json`;
    await writeFile(join(MEDIA_ROOT, rel), JSON.stringify(data, null, 2));
    return { path: rel, provider: "brightdata" };
  }
  await mkdir(join(MEDIA_ROOT, "crawl"), { recursive: true });
  const rel = `crawl/mock-${Date.now()}.json`;
  await writeFile(
    join(MEDIA_ROOT, rel),
    JSON.stringify({
      mock: true,
      query,
      note: "Add FIRECRAWL_API_KEY and/or BRIGHTDATA_API_KEY + BRIGHTDATA_SERP_ZONE",
    }, null, 2)
  );
  return { path: rel, provider: "mock" };
}

async function handle(job) {
  const { jobId, projectId, payload = {}, kind } = job.data;

  if (kind === "crawl") {
    const result = await crawl(payload);
    const provider =
      result.provider === "mock"
        ? "brightdata"
        : result.provider === "firecrawl"
          ? "firecrawl"
          : "brightdata";
    await callback({
      jobId,
      status: "completed",
      result,
      settle: { provider, unitKind: "request", units: 1 },
      lastChangeSummary: `Crawl ${result.provider}`,
    });
    // Also insert asset row
    if (projectId) {
      await pool.query(
        `INSERT INTO assets (kind, filename, path, notes, primary_project_id, metadata)
         VALUES ('doc', $1, $2, $3, $4, $5)`,
        [result.path, result.path, `Crawled via ${result.provider}`, projectId, JSON.stringify(result)]
      );
    }
    return;
  }

  const assetId = payload.assetId;
  const mediaKind = payload.mediaKind || payload.kind;
  const relPath = payload.path;
  if (!assetId) {
    await callback({ jobId, status: "failed", error: "no assetId" });
    return;
  }

  let caption = `${mediaKind} asset`;
  let transcript = null;
  let metadata = {};

  if (mediaKind === "video") {
    const abs = join(MEDIA_ROOT, relPath);
    const vi = await azureUnderstand(abs, relPath);
    transcript = vi.transcript;
    caption = `Video: ${(vi.labels || []).join(", ") || "understood"}`;
    metadata = { videoIndexer: vi };
    await callback({
      jobId,
      status: "completed",
      result: { assetId, vi },
      settle: {
        provider: "azure_video_indexer",
        unitKind: "minute",
        units: vi.mock ? 0.1 : Math.max(0.1, (Number(vi.durationSec) || 60) / 60),
        meta: { mock: vi.mock, videoId: vi.videoId || null, state: vi.state || null },
      },
    });
  } else if (mediaKind === "image") {
    caption = `Image upload ${relPath}`;
  } else if (mediaKind === "audio" || mediaKind === "music") {
    transcript = "Audio asset pending detailed STT";
    caption = `Audio ${relPath}`;
  }

  const content = [caption, transcript, ""].filter(Boolean).join("\n");
  await pool.query(
    `UPDATE assets SET caption = $1, transcript = $2, metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb WHERE id = $4`,
    [caption, transcript, JSON.stringify(metadata), assetId]
  );

  const embedding = await embedText(content);
  if (embedding) {
    const vec = `[${embedding.join(",")}]`;
    await pool.query(
      `INSERT INTO asset_embeddings (asset_id, content, embedding) VALUES ($1, $2, $3::vector)`,
      [assetId, content, vec]
    );
    if (projectId) {
      await pool.query(
        `INSERT INTO spend_events (project_id, provider, unit_kind, units, rate_snapshot, estimated_usd, actual_usd, status, settled_at)
         SELECT $1, 'openai_embedding', 'token', 300, unit_price_usd, unit_price_usd*300, unit_price_usd*300, 'settled', now()
         FROM rate_cards WHERE provider='openai_embedding' AND unit_kind='token' LIMIT 1`,
        [projectId]
      );
    }
  }

  if (mediaKind !== "video") {
    await callback({ jobId, status: "completed", result: { assetId, caption } });
  }
}

new Worker(
  "ingest",
  async (job) => {
    console.log("ingest job", job.id, job.data.kind);
    await handle(job);
  },
  // Video Indexer upload+poll can take several minutes
  { connection, lockDuration: 10 * 60 * 1000 }
);

const azureArmReady = Boolean(
  process.env.AZURE_SUBSCRIPTION_ID &&
    process.env.AZURE_RESOURCE_GROUP &&
    process.env.AZURE_VIDEO_INDEXER_ACCOUNT_NAME
);
const azureClassicReady = Boolean(
  (process.env.AZURE_VIDEO_INDEXER_SUBSCRIPTION_KEY || "").trim() &&
    process.env.AZURE_VIDEO_INDEXER_ACCOUNT_ID
);
console.log(
  "worker-ingest listening VI_UPLOAD_INDEX_BUILD",
  azureArmReady
    ? `(Azure ARM auth, loc=${process.env.AZURE_VIDEO_INDEXER_LOCATION || "eastus"}, account=${process.env.AZURE_VIDEO_INDEXER_ACCOUNT_NAME})`
    : azureClassicReady
      ? `(Azure classic key, loc=${process.env.AZURE_VIDEO_INDEXER_LOCATION || "eastus"})`
      : "(Azure VI mock without ARM/classic credentials)"
);
