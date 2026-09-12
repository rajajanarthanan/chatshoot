import { spawn } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let err = "";
    p.stderr.on("data", (d) => {
      err += d.toString();
    });
    p.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`));
    });
  });
}

/** Soft ambient bed (brown noise + low tones) — no stock music license needed. */
export async function makeSoftMusicBed(mediaRoot, jobId, durationSec) {
  await mkdir(join(mediaRoot, "audio"), { recursive: true });
  const bedAbs = join(mediaRoot, "audio", `${jobId}-bed.mp3`);
  const fadeOutStart = Math.max(0.5, durationSec - 1.5);
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=color=brown:duration=${durationSec}:sample_rate=44100`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=130.81:duration=${durationSec}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=196:duration=${durationSec}`,
    "-filter_complex",
    `[0:a]volume=0.035,lowpass=f=600[n];[1:a]volume=0.028[s1];[2:a]volume=0.022[s2];[n][s1][s2]amix=inputs=3:duration=longest,afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart}:d=1.5[a]`,
    "-map",
    "[a]",
    "-t",
    String(durationSec),
    "-q:a",
    "4",
    bedAbs,
  ]);
  return { bedAbs, bedRel: `audio/${jobId}-bed.mp3` };
}

/**
 * Edit ops on local media files (ffmpeg).
 * Returns relative path under MEDIA_ROOT.
 */
export async function applyVideoEdits(opts) {
  const {
    mediaRoot,
    inputRel,
    jobId,
    stackHalvesTb = false,
    crop916 = false,
    trimStartSec,
    trimEndSec,
  } = opts;

  if (!inputRel) return { outputRel: null, ops: [] };
  const inputAbs = join(mediaRoot, inputRel);
  const ops = [];
  let current = inputAbs;
  const outDir = join(mediaRoot, "edits");
  await mkdir(outDir, { recursive: true });

  const nextOut = (tag) => join(outDir, `${jobId}-${tag}.mp4`);

  if (typeof trimStartSec === "number" || typeof trimEndSec === "number") {
    const out = nextOut("trim");
    const args = ["-y"];
    if (typeof trimStartSec === "number") args.push("-ss", String(trimStartSec));
    args.push("-i", current);
    if (typeof trimEndSec === "number") {
      const dur =
        typeof trimStartSec === "number" ? Math.max(0.1, trimEndSec - trimStartSec) : trimEndSec;
      args.push("-t", String(dur));
    }
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart", out);
    await run("ffmpeg", args);
    current = out;
    ops.push("trim");
  }

  if (stackHalvesTb) {
    // Split L|R into top/bottom stack for vertical delivery
    const out = nextOut("vstack");
    // crop left + right, scale each to full width x half height, vstack
    const fc = [
      "[0:v]crop=iw/2:ih:0:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[left]",
      "[0:v]crop=iw/2:ih:iw/2:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[right]",
      "[left][right]vstack=inputs=2[v]",
    ].join(";");
    await run("ffmpeg", [
      "-y",
      "-i",
      current,
      "-filter_complex",
      fc,
      "-map",
      "[v]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      out,
    ]);
    current = out;
    ops.push("stack_halves_tb");
  }

  if (crop916 && !stackHalvesTb) {
    const out = nextOut("916");
    // Center crop to 9:16 then scale 1080x1920
    await run("ffmpeg", [
      "-y",
      "-i",
      current,
      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      out,
    ]);
    current = out;
    ops.push("crop_916");
  }

  if (!ops.length) {
    return { outputRel: inputRel, ops: [] };
  }

  const rel = current.replace(mediaRoot.replace(/\\/g, "/"), "").replace(/^\//, "");
  // normalize relative
  const outputRel = current.startsWith(mediaRoot)
    ? current.slice(mediaRoot.length).replace(/^[\\/]/, "")
    : `edits/${dirname(current).split(/[\\/]/).pop()}`;
  const fixedRel = current.includes(`${mediaRoot}/`)
    ? current.split(`${mediaRoot}/`).pop()
    : current.includes(`${mediaRoot}\\`)
      ? current.split(`${mediaRoot}\\`).pop()
      : join("edits", current.split(/[\\/]/).pop());

  return { outputRel: fixedRel.replace(/\\/g, "/"), ops, outputAbs: current };
}

/**
 * Stitch a simple vertical promo MP4 from kit assets (export).
 */
export async function exportKitMp4(opts) {
  const {
    mediaRoot,
    jobId,
    titleText = "Chatshoot",
    subtitle = "",
    ctaText = "Learn more",
    brandName = "Chatshoot",
    logoAbs,
    productAbs,
    brollAbs,
    audioAbs = null,
    captions = [],
    durationSec = 30,
    music = true,
    musicAbs = null,
  } = opts;

  await mkdir(join(mediaRoot, "renders"), { recursive: true });
  await mkdir(join(mediaRoot, "tmp"), { recursive: true });

  const fps = 30;
  const w = 1080;
  const h = 1920;
  const beatLogo = opts.beats?.logo ?? 2.2;
  const beatProduct = opts.beats?.product ?? 7;
  const beatBroll = opts.beats?.broll ?? 14;
  const beatCta = Math.max(4, durationSec - beatLogo - beatProduct - beatBroll);

  const safe = (s) =>
    String(s || "")
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:")
      .replace(/'/g, "")
      .slice(0, 90);

  const logoCard = join(mediaRoot, "tmp", `${jobId}-logo.mp4`);
  const productCard = join(mediaRoot, "tmp", `${jobId}-product.mp4`);
  const ctaCard = join(mediaRoot, "tmp", `${jobId}-cta.mp4`);
  const brollSeg = join(mediaRoot, "tmp", `${jobId}-broll.mp4`);
  const outAbs = join(mediaRoot, "renders", `${jobId}-export.mp4`);

  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  const draw = (text, opts) =>
    `drawtext=fontfile=${font}:text='${safe(text)}':${opts}`;

  // Logo card
  if (logoAbs) {
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x0b1220:s=${w}x${h}:d=${beatLogo}`,
      "-i",
      logoAbs,
      "-filter_complex",
      `[1:v]scale=280:280:force_original_aspect_ratio=decrease[lg];[0:v][lg]overlay=(W-w)/2:(H-h)/2-80,${draw(brandName, "fontcolor=0x3dd6c6:fontsize=36:x=(w-text_w)/2:y=(h/2)+180")}`,
      "-t",
      String(beatLogo),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      logoCard,
    ]);
  } else {
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x0b1220:s=${w}x${h}:d=${beatLogo}`,
      "-vf",
      draw(brandName, "fontcolor=0x3dd6c6:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2"),
      "-t",
      String(beatLogo),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      logoCard,
    ]);
  }

  // Product / UI card
  if (productAbs) {
    await run("ffmpeg", [
      "-y",
      "-loop",
      "1",
      "-i",
      productAbs,
      "-vf",
      `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},${draw(titleText, "fontcolor=white:fontsize=48:x=48:y=h-320")},${draw(String(subtitle).slice(0, 70), "fontcolor=0xc8d4ea:fontsize=26:x=48:y=h-200")}`,
      "-t",
      String(beatProduct),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      productCard,
    ]);
  } else {
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x121a2b:s=${w}x${h}:d=${beatProduct}`,
      "-vf",
      draw(titleText, "fontcolor=white:fontsize=56:x=(w-text_w)/2:y=(h-text_h)/2"),
      "-t",
      String(beatProduct),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      productCard,
    ]);
  }

  // B-roll segment
  if (brollAbs) {
    await run("ffmpeg", [
      "-y",
      "-i",
      brollAbs,
      "-t",
      String(beatBroll),
      "-vf",
      `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},${draw(String(subtitle).slice(0, 60), "fontcolor=white:fontsize=34:x=48:y=h-220")}`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-an",
      "-pix_fmt",
      "yuv420p",
      brollSeg,
    ]);
  } else {
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x0f172a:s=${w}x${h}:d=${beatBroll}`,
      "-vf",
      draw(subtitle || titleText, "fontcolor=white:fontsize=40:x=48:y=h-240"),
      "-t",
      String(beatBroll),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      brollSeg,
    ]);
  }

  // CTA card
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x0b1220:s=${w}x${h}:d=${beatCta}`,
    "-vf",
    `${draw(titleText, "fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h/2)-80")},${draw(ctaText, "fontcolor=0x0b1220:fontsize=36:box=1:boxcolor=0x3dd6c6:boxborderw=18:x=(w-text_w)/2:y=(h/2)+40")}`,
    "-t",
    String(beatCta),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    ctaCard,
  ]);

  const listFile = join(mediaRoot, "tmp", `${jobId}-concat.txt`);
  const { writeFile } = await import("fs/promises");
  await writeFile(
    listFile,
    [logoCard, productCard, brollSeg, ctaCard].map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
  );

  const silentAbs = join(mediaRoot, "tmp", `${jobId}-silent.mp4`);
  await run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    silentAbs,
  ]);

  const totalDur = beatLogo + beatProduct + beatBroll + beatCta;
  let videoAbs = silentAbs;
  const capLines = (Array.isArray(captions) ? captions : [])
    .map((c) => String(c || "").trim())
    .filter(Boolean)
    .slice(0, 6);
  if (capLines.length) {
    const captionedAbs = join(mediaRoot, "tmp", `${jobId}-caps.mp4`);
    const slice = Math.max(2, totalDur / capLines.length);
    const vf = capLines
      .map((line, i) => {
        const start = (i * slice).toFixed(2);
        const end = ((i + 1) * slice).toFixed(2);
        return draw(line, `fontcolor=white:fontsize=36:x=(w-text_w)/2:y=h-160:enable='between(t,${start},${end})':box=1:boxcolor=0x00000099:boxborderw=12`);
      })
      .join(",");
    await run("ffmpeg", [
      "-y",
      "-i",
      silentAbs,
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      captionedAbs,
    ]);
    videoAbs = captionedAbs;
  }

  let musicRel = null;
  let bedAbs = null;
  if (music) {
    try {
      if (musicAbs) {
        // Normalize gallery track to full duration (loop/trim) at bed level
        const normalized = join(mediaRoot, "tmp", `${jobId}-gallery-bed.mp3`);
        await mkdir(join(mediaRoot, "tmp"), { recursive: true });
        await run("ffmpeg", [
          "-y",
          "-stream_loop",
          "-1",
          "-i",
          musicAbs,
          "-t",
          String(totalDur),
          "-af",
          "volume=0.85,afade=t=in:st=0:d=0.8,afade=t=out:st=" + Math.max(0.5, totalDur - 1.2) + ":d=1.2",
          "-q:a",
          "4",
          normalized,
        ]);
        bedAbs = normalized;
        musicRel = String(musicAbs).includes(`${mediaRoot}/`)
          ? String(musicAbs).slice(String(mediaRoot).length + 1).replace(/\\/g, "/")
          : null;
      } else {
        const bed = await makeSoftMusicBed(mediaRoot, jobId, totalDur);
        bedAbs = bed.bedAbs;
        musicRel = bed.bedRel;
      }
    } catch (e) {
      console.warn("music bed failed", e);
    }
  }

  if (audioAbs && bedAbs) {
    // VO padded to full length + quiet bed underneath
    await run("ffmpeg", [
      "-y",
      "-i",
      videoAbs,
      "-i",
      audioAbs,
      "-i",
      bedAbs,
      "-filter_complex",
      `[1:a]apad=whole_dur=${totalDur}[vo];[2:a]volume=0.2[bed];[vo][bed]amix=inputs=2:duration=first:dropout_transition=2[a]`,
      "-map",
      "0:v:0",
      "-map",
      "[a]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-t",
      String(totalDur),
      "-movflags",
      "+faststart",
      outAbs,
    ]);
  } else if (audioAbs) {
    // Keep full video length; pad VO with silence if shorter (never -shortest truncate).
    await run("ffmpeg", [
      "-y",
      "-i",
      videoAbs,
      "-i",
      audioAbs,
      "-filter_complex",
      `[1:a]apad=whole_dur=${totalDur}[a]`,
      "-map",
      "0:v:0",
      "-map",
      "[a]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-t",
      String(totalDur),
      "-movflags",
      "+faststart",
      outAbs,
    ]);
  } else if (bedAbs) {
    await run("ffmpeg", [
      "-y",
      "-i",
      videoAbs,
      "-i",
      bedAbs,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-t",
      String(totalDur),
      "-movflags",
      "+faststart",
      outAbs,
    ]);
  } else {
    await run("ffmpeg", [
      "-y",
      "-i",
      videoAbs,
      "-c:v",
      "copy",
      "-an",
      "-movflags",
      "+faststart",
      outAbs,
    ]);
  }

  return {
    outputRel: `renders/${jobId}-export.mp4`,
    outputAbs: outAbs,
    durationSec: totalDur,
    hasAudio: Boolean(audioAbs || bedAbs),
    musicRel,
    captionCount: capLines.length,
  };
}

/**
 * CapCut-style export: concat V1 clips by order (trim via sourceIn/dur).
 * Falls back to exportKitMp4 when all clips have kit roles and kitAssets provided.
 */
export async function exportTimelineMp4(opts) {
  const {
    mediaRoot,
    jobId,
    clips = [],
    audioAbs = null,
    musicAbs = null,
    durationSec = 30,
    kitAssets = null,
    titleText,
    subtitle,
    ctaText,
    brandName,
    captions = [],
  } = opts;

  const roles = ["logo", "product", "broll", "cta"];
  const allKit =
    clips.length >= 3 &&
    clips.every((c) => c.role && roles.includes(c.role)) &&
    kitAssets;

  if (allKit) {
    const beatMap = {};
    for (const c of clips) beatMap[c.role] = c.durSec;
    return exportKitMp4({
      mediaRoot,
      jobId,
      titleText,
      subtitle,
      ctaText,
      brandName,
      logoAbs: kitAssets.logoAbs,
      productAbs: kitAssets.productAbs,
      brollAbs: kitAssets.brollAbs,
      audioAbs,
      musicAbs,
      captions,
      durationSec,
      music: Boolean(musicAbs || audioAbs),
      beats: beatMap,
    });
  }

  await mkdir(join(mediaRoot, "renders"), { recursive: true });
  await mkdir(join(mediaRoot, "tmp"), { recursive: true });
  const w = 1080;
  const h = 1920;
  const segs = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const abs = c.absPath;
    const dur = Math.max(0.2, Number(c.durSec) || 3);
    const out = join(mediaRoot, "tmp", `${jobId}-seg-${i}.mp4`);
    if (abs && existsSync(abs)) {
      const args = ["-y"];
      if (c.sourceInSec != null) args.push("-ss", String(c.sourceInSec));
      args.push("-i", abs, "-t", String(dur));
      const isImg = /\.(png|jpe?g|webp|svg)$/i.test(abs);
      if (isImg) {
        args.splice(1, 0, "-loop", "1");
        args.push(
          "-vf",
          `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-an",
          out
        );
      } else {
        args.push(
          "-vf",
          `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-an",
          out
        );
      }
      await run("ffmpeg", args);
    } else {
      await run("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x0b1220:s=${w}x${h}:d=${dur}`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
        out,
      ]);
    }
    segs.push(out);
  }

  if (!segs.length) {
    throw new Error("exportTimelineMp4: no clips");
  }

  const listPath = join(mediaRoot, "tmp", `${jobId}-tl.txt`);
  await writeFile(listPath, segs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const videoAbs = join(mediaRoot, "tmp", `${jobId}-tl-video.mp4`);
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", videoAbs]);

  const totalDur = clips.reduce((s, c) => s + Math.max(0.2, Number(c.durSec) || 3), 0);
  const outAbs = join(mediaRoot, "renders", `${jobId}-export.mp4`);
  if (audioAbs || musicAbs) {
    const inputs = ["-y", "-i", videoAbs];
    if (audioAbs) inputs.push("-i", audioAbs);
    if (musicAbs) inputs.push("-i", musicAbs);
    // simple: prefer VO if present else music
    const aIdx = audioAbs ? 1 : musicAbs ? 1 : null;
    if (aIdx != null) {
      await run("ffmpeg", [
        ...inputs,
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-map",
        "0:v:0",
        "-map",
        `${aIdx}:a:0?`,
        "-t",
        String(totalDur),
        "-shortest",
        "-movflags",
        "+faststart",
        outAbs,
      ]);
    } else {
      await run("ffmpeg", ["-y", "-i", videoAbs, "-c", "copy", "-movflags", "+faststart", outAbs]);
    }
  } else {
    await run("ffmpeg", ["-y", "-i", videoAbs, "-c", "copy", "-movflags", "+faststart", outAbs]);
  }

  return {
    outputRel: `renders/${jobId}-export.mp4`,
    outputAbs: outAbs,
    durationSec: totalDur,
    hasAudio: Boolean(audioAbs || musicAbs),
  };
}
