/** CapCut v2 builder for remotion worker — freeform by default; kit beats only if kit=saas_promo. */

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function buildTimelineV2({
  durationSec,
  kit,
  beats,
  clips,
  brollLayout,
  editOps,
  assets,
  audioUrl,
  musicUrl,
}) {
  const d = Math.min(Math.max(Number(durationSec) || 30, 1), 180);
  const isKit = kit === "saas_promo";

  let videoClips;
  if (Array.isArray(clips) && clips.length) {
    let t = 0;
    videoClips = clips.map((c, i) => {
      const dur = Math.max(0.5, Number(c.durSec) || 4);
      const clip = {
        id: c.id || uid(`clip${i}`),
        role: c.role || c.label || undefined,
        fromSec: Number(t.toFixed(3)),
        durSec: dur,
        assetRef: c.assetRef || {
          url: c.url || null,
          path: c.path || null,
          assetId: c.assetId || null,
          slot: c.slot || undefined,
        },
        transform: c.transform,
      };
      t += dur;
      return clip;
    });
  } else if (isKit) {
    const b =
      Array.isArray(beats) && beats.length
        ? beats
        : [
            { id: "logo", fromSec: 0, durSec: 2.2, type: "logo" },
            { id: "product", fromSec: 2.2, durSec: 7, type: "product" },
            { id: "broll", fromSec: 9.2, durSec: 14, type: "broll", layout: brollLayout },
            { id: "cta", fromSec: 23.2, durSec: Math.max(4, d - 23.2), type: "cta" },
          ];
    const slot = { logo: "logoUrl", product: "productImageUrl", broll: "brollUrl", cta: "ctaText" };
    videoClips = b.map((beat, i) => ({
      id: `clip_${beat.id || i}_${i}`,
      role: beat.id || beat.type,
      fromSec: beat.fromSec,
      durSec: beat.durSec,
      assetRef: {
        slot: slot[beat.id] || slot[beat.type],
        url: assets?.[slot[beat.id] || slot[beat.type]] || null,
      },
      transform: beat.layout ? { layout: beat.layout } : undefined,
    }));
  } else {
    // Freeform: one clip per available media asset URL
    const media = [];
    if (assets?.plateUrl) media.push({ role: "plate", url: assets.plateUrl, durSec: 6 });
    if (assets?.productImageUrl && assets.productImageUrl !== assets.plateUrl) {
      media.push({ role: "still", url: assets.productImageUrl, durSec: 4 });
    }
    if (assets?.logoUrl) media.push({ role: "still", url: assets.logoUrl, durSec: 3 });
    if (assets?.brollUrl) media.push({ role: "footage", url: assets.brollUrl, durSec: 8 });
    if (assets?.genfillUrl) media.push({ role: "genfill", url: assets.genfillUrl, durSec: 5 });
    let t = 0;
    videoClips = media.map((m, i) => {
      const clip = {
        id: uid(`m${i}`),
        role: m.role,
        fromSec: Number(t.toFixed(3)),
        durSec: m.durSec,
        assetRef: { url: m.url },
      };
      t += m.durSec;
      return clip;
    });
  }

  const duration = Math.max(
    d,
    videoClips.reduce((s, c) => Math.max(s, c.fromSec + c.durSec), 0)
  );

  return {
    version: 2,
    fps: 30,
    durationSec: duration,
    kit: isKit ? "saas_promo" : kit ?? null,
    tracks: [
      { id: "V1", kind: "video", clips: videoClips },
      {
        id: "A1",
        kind: "audio",
        clips: audioUrl
          ? [{ id: "vo_0", role: "vo", fromSec: 0, durSec: duration, assetRef: { slot: "audioUrl", url: audioUrl }, volume: 1 }]
          : [],
      },
      {
        id: "A2",
        kind: "audio",
        clips: musicUrl
          ? [
              {
                id: "music_0",
                role: "music",
                fromSec: 0,
                durSec: duration,
                assetRef: { slot: "musicUrl", url: musicUrl },
                volume: 0.18,
              },
            ]
          : [],
      },
    ],
    beats: videoClips.map((c) => ({
      id: c.role || c.id,
      fromSec: c.fromSec,
      durSec: c.durSec,
      type: c.role || "clip",
      layout: c.transform?.layout,
    })),
    brollLayout,
    editOps,
    assets,
  };
}
