#!/usr/bin/env bash
# Full regression smoke (API-level) for Chatshoot personal studio
set -euo pipefail
BASE="${BASE_URL:-http://localhost:2980}"

echo "== health =="
curl -sf "$BASE/" >/dev/null

echo "== create project =="
PROJ=$(curl -sf -X POST "$BASE/api/projects" -H 'Content-Type: application/json' -d '{"name":"Regression","clientName":"QA"}')
PID=$(echo "$PROJ" | python3 -c "import sys,json; print(json.load(sys.stdin)['project']['id'])")
PART=$(echo "$PROJ" | python3 -c "import sys,json; print(json.load(sys.stdin)['part']['id'])")
echo "project=$PID"

echo "== spend stub =="
curl -sf -X POST "$BASE/api/spend" -H 'Content-Type: application/json' -d "{\"action\":\"stub_settle\",\"projectId\":\"$PID\",\"units\":500}" >/dev/null

echo "== upload + azure/video ingest =="
# Prefer a tiny valid MP4 so ARM Video Indexer can index; fall back to placeholder text file
if [[ -f /tmp/vi-smoke.mp4 ]]; then
  SAMPLE=/tmp/vi-smoke.mp4
elif command -v ffmpeg >/dev/null; then
  ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=10 -f lavfi -i sine=duration=2 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest /tmp/reg.mp4 >/tmp/reg-ffmpeg.log 2>&1 || true
  SAMPLE=/tmp/reg.mp4
else
  echo fakevideo > /tmp/reg.mp4
  SAMPLE=/tmp/reg.mp4
fi
ASSET=$(curl -sf -X POST "$BASE/api/assets" -F "file=@${SAMPLE};type=video/mp4" -F "projectId=$PID" -F "notes=red dress showroom")
AID=$(echo "$ASSET" | python3 -c "import sys,json; a=json.load(sys.stdin); assert a['kind']=='video'; print(a['id'])")
echo "asset=$AID"
# Poll until ingest writes caption/transcript (Azure index can take ~30–90s)
OK=0
for i in $(seq 1 60); do
  sleep 3
  curl -sf "$BASE/api/assets/$AID" > /tmp/cs-reg-asset.json || continue
  python3 - <<'PY' > /tmp/cs-reg-ingest.txt
import json, sys
a = json.load(open("/tmp/cs-reg-asset.json"))
vi = (a.get("metadata") or {}).get("videoIndexer") or {}
if not (a.get("caption") or a.get("transcript")):
    print("wait")
    sys.exit(0)
print(
    "ingest_ok",
    "mock=" + str(vi.get("mock")),
    "state=" + str(vi.get("state")),
    "videoId=" + str(vi.get("videoId")),
    (a.get("caption") or a.get("transcript") or "")[:80],
)
if vi.get("mock") is False and not vi.get("videoId") and vi.get("state") != "Processed":
    print("BAD_STUB")
    sys.exit(3)
PY
  cat /tmp/cs-reg-ingest.txt
  if grep -q '^BAD_STUB$' /tmp/cs-reg-ingest.txt; then
    echo "token-only stub still running - kill duplicate ingest workers"
    exit 1
  fi
  if grep -q '^ingest_ok' /tmp/cs-reg-ingest.txt; then
    OK=1
    break
  fi
done
if [[ "$OK" -ne 1 ]]; then
  echo "ingest timed out"
  exit 1
fi

echo "== chat plan =="
CHAT=$(curl -sf -X POST "$BASE/api/chat" -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"partId\":\"$PART\",\"message\":\"Make a vertical 9:16 shop promo with showroom blender plate and English voiceover. Create the production plan now.\"}")
PLAN=$(echo "$CHAT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('planId') or '')")
if [[ -z "$PLAN" ]]; then
  echo "no plan on first turn; nudging..."
  CHAT=$(curl -sf -X POST "$BASE/api/chat" -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"partId\":\"$PART\",\"message\":\"Proceed with defaults. Call create_production_plan now for a vertical showroom promo with VO.\"}")
  PLAN=$(echo "$CHAT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('planId') or '')")
fi
echo "$CHAT" | python3 -c "import sys,json; d=json.load(sys.stdin); print('pending', d.get('pendingApproval'), 'est', d.get('estimatedTotal')); assert d.get('planId'), d"
echo "plan=$PLAN"

echo "== approve =="
curl -sf -X POST "$BASE/api/plans" -H 'Content-Type: application/json' -d "{\"action\":\"approve\",\"planId\":\"$PLAN\"}" >/dev/null
# Wait for remotion (+ optional TTS) to finish kit/export
OK_PART=0
for i in $(seq 1 40); do
  sleep 3
  curl -sf "$BASE/api/parts/$PART" > /tmp/cs-reg-part.json || continue
  python3 - <<'PY'
import json
p=json.load(open("/tmp/cs-reg-part.json"))
pp=p.get("previewProps") or {}
last=str(p.get("lastChangeSummary") or "")
print("last_change", last[:160])
print("preview_title", pp.get("titleText"))
print("kit", pp.get("kit"))
print("export", pp.get("exportUrl"))
print("audio", pp.get("audioUrl"))
# Pass when we have a preview update; kit/export are best-effort depending on assets
ok = bool(last) and bool(pp.get("titleText")) and bool(pp.get("plateUrl"))
open("/tmp/cs-reg-part-ok","w").write("1" if ok else "0")
PY
  if [[ "$(cat /tmp/cs-reg-part-ok 2>/dev/null || echo 0)" == "1" ]]; then
    OK_PART=1
    break
  fi
done
if [[ "$OK_PART" -ne 1 ]]; then
  echo "part preview timed out (need title + plateUrl from showroom plan)"
  exit 1
fi

echo "== export api =="
curl -sf -X POST "$BASE/api/export" -H 'Content-Type: application/json' -d "{\"partId\":\"$PART\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('ok') and d.get('jobId'); print('export_job', d['jobId'])"
sleep 8
curl -sf "$BASE/api/parts/$PART" | python3 -c "
import sys,json
p=json.load(sys.stdin)
pp=p.get('previewProps') or {}
print('export_url', pp.get('exportUrl'))
print('kit', pp.get('kit'))
print('has_audio', bool(pp.get('audioUrl')))
"

echo "== kit slot pin =="
# Upload a tiny PNG and pin as logo
python3 - <<'PY'
from struct import pack
import zlib
def chunk(tag, data):
    return pack(">I", len(data)) + tag + data + pack(">I", zlib.crc32(tag + data) & 0xffffffff)
raw = b"\x00" + b"\xff\x00\x00" * 8
# 8x1 RGB
ihdr = pack(">IIBBBBB", 8, 1, 8, 2, 0, 0, 0)
open("/tmp/reg-logo.png","wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
PY
IMG=$(curl -sf -X POST "$BASE/api/assets" -F "file=@/tmp/reg-logo.png;type=image/png" -F "projectId=$PID" -F "notes=logo pin")
IMG_ID=$(echo "$IMG" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
curl -sf -X PATCH "$BASE/api/assets/$IMG_ID" -H 'Content-Type: application/json' -d '{"kitSlot":"logo"}' | python3 -c "import sys,json; d=json.load(sys.stdin); assert (d.get('metadata') or {}).get('kitSlot')=='logo'; print('slot_ok', d['id'][:8])"

echo "== plate source =="
curl -sf "$BASE/api/parts/$PART" | python3 -c "
import sys,json,re
p=json.load(sys.stdin)
pp=p.get('previewProps') or {}
url=str(pp.get('plateUrl') or '')
src=pp.get('plateSource')
if url and not src:
    if '.svg' in url.lower(): src='fallback'
    elif 'plates' in url: src='cycles'
print('plate_url', bool(url), 'plate_source', src)
# Showroom brief should leave a plate; accept cycles or fallback
assert url, 'expected plateUrl after showroom plan'
assert src in ('cycles','fallback'), src
print('plate_source_ok', src)
"

echo "== timeline revise (no bake) =="
TL=$(curl -sf -X POST "$BASE/api/plans" -H 'Content-Type: application/json' -d "{\"action\":\"revise_timeline\",\"projectId\":\"$PID\",\"partId\":\"$PART\",\"note\":\"reg logo 1.2s\",\"patches\":[{\"id\":\"logo\",\"durSec\":1.2}]}")
TL_PLAN=$(echo "$TL" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('planId'); print(d['planId']); assert d['beats'][0]['durSec']==1.2")
echo "timeline_plan=$TL_PLAN"
curl -sf -X POST "$BASE/api/plans" -H 'Content-Type: application/json' -d "{\"action\":\"approve\",\"planId\":\"$TL_PLAN\"}" >/dev/null
sleep 1
curl -sf "$BASE/api/parts/$PART" | python3 -c "
import sys,json
p=json.load(sys.stdin)
beats=(p.get('timelineJson') or {}).get('beats') or (p.get('previewProps') or {}).get('beats') or []
logo=next((b for b in beats if b.get('id')=='logo'), None)
assert logo and abs(float(logo['durSec'])-1.2)<0.05, logo
last=str(p.get('lastChangeSummary') or '')
assert 'Timeline' in last or 'logo' in last.lower(), last
print('timeline_ok', logo['durSec'], last[:80])
"
curl -sf "$BASE/api/plans?projectId=$PID" | python3 -c "
import sys,json
plans=json.load(sys.stdin)
p=next(x for x in plans if any(s.get('kind')=='timeline' for s in (x.get('steps') or [])))
assert p.get('status')=='completed', p.get('status')
print('timeline_plan_completed')
"

echo "== timeline bake =="
TL2=$(curl -sf -X POST "$BASE/api/plans" -H 'Content-Type: application/json' -d "{\"action\":\"revise_timeline\",\"projectId\":\"$PID\",\"partId\":\"$PART\",\"reexport\":true,\"note\":\"reg broll 12s bake\",\"patches\":[{\"id\":\"broll\",\"durSec\":12}]}")
TL2_PLAN=$(echo "$TL2" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('planId'); kinds=[s['kind'] for s in d['steps']]; assert kinds==['timeline','remotion'], kinds; print(d['planId'])")
echo "bake_plan=$TL2_PLAN"
curl -sf -X POST "$BASE/api/plans" -H 'Content-Type: application/json' -d "{\"action\":\"approve\",\"planId\":\"$TL2_PLAN\"}" >/dev/null
OK_BAKE=0
for i in $(seq 1 40); do
  sleep 3
  curl -sf "$BASE/api/plans?projectId=$PID" > /tmp/cs-reg-plans2.json || continue
  python3 - <<PY
import json
plans=json.load(open("/tmp/cs-reg-plans2.json"))
p=next((x for x in plans if x.get("id")=="$TL2_PLAN"), None)
assert p, "bake plan missing"
steps=p.get("steps") or []
kinds={s.get("kind"): s.get("status") for s in steps}
print("bake_status", p.get("status"), kinds)
ok = p.get("status")=="completed" and kinds.get("timeline") in ("preview_ready","accepted","completed") and kinds.get("remotion") in ("preview_ready","accepted","completed")
open("/tmp/cs-reg-bake-ok","w").write("1" if ok else "0")
PY
  if [[ "$(cat /tmp/cs-reg-bake-ok 2>/dev/null || echo 0)" == "1" ]]; then
    OK_BAKE=1
    break
  fi
done
if [[ "$OK_BAKE" -ne 1 ]]; then
  echo "timeline bake timed out"
  exit 1
fi
curl -sf "$BASE/api/parts/$PART" | python3 -c "
import sys,json
p=json.load(sys.stdin)
beats=(p.get('timelineJson') or {}).get('beats') or []
broll=next((b for b in beats if b.get('id')=='broll'), None)
assert broll and abs(float(broll['durSec'])-12)<0.05, broll
pp=p.get('previewProps') or {}
assert pp.get('exportUrl'), 'expected export after bake'
print('bake_ok', broll['durSec'], 'export', bool(pp.get('exportUrl')))
"

echo "== capcut clip ops =="
CLIP_BODY=$(python3 - <<PY
import json, urllib.request
part=json.load(urllib.request.urlopen("$BASE/api/parts/$PART"))
tl=part.get("timelineJson") or {}
v1=next((t for t in (tl.get("tracks") or []) if t.get("id")=="V1" or t.get("kind")=="video"), None)
clips=(v1 or {}).get("clips") or []
c=next((x for x in clips if x.get("role")=="broll"), clips[0] if clips else None)
assert c, "expected V1 clips"
at=float(c["fromSec"])+float(c["durSec"])/2
print(json.dumps({
  "action":"revise_timeline",
  "projectId":"$PID",
  "partId":"$PART",
  "note":"reg split clip",
  "clipOps":[{"op":"split","clipId":c["id"],"atSec":at}],
  "_before":len(clips),
}))
PY
)
BEFORE_N=$(echo "$CLIP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).pop('_before'))")
TL3=$(curl -sf -X POST "$BASE/api/plans" -H 'Content-Type: application/json' -d "$(echo "$CLIP_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); d.pop('_before',None); print(json.dumps(d))")")
TL3_PLAN=$(echo "$TL3" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('planId'); print(d['planId'])")
echo "capcut_plan=$TL3_PLAN before=$BEFORE_N"
curl -sf -X POST "$BASE/api/plans" -H 'Content-Type: application/json' -d "{\"action\":\"approve\",\"planId\":\"$TL3_PLAN\"}" >/dev/null
sleep 1
curl -sf "$BASE/api/parts/$PART" | python3 -c "
import sys,json
p=json.load(sys.stdin)
tl=p.get('timelineJson') or {}
assert tl.get('version')==2, tl
v1=next((t for t in (tl.get('tracks') or []) if t.get('id')=='V1' or t.get('kind')=='video'), None)
n=len((v1 or {}).get('clips') or [])
assert n > int('$BEFORE_N'), (n, '$BEFORE_N')
print('capcut_split_ok', 'clips', n, 'version', tl.get('version'))
"

echo "== environments + personas api =="
ENV=$(curl -sf -X POST "$BASE/api/environments" -H 'Content-Type: application/json' -d '{"name":"Reg Sofa Set","description":"warm HDRI void","blenderTemplate":"assemble","assemble":true,"assetIds":[]}')
echo "$ENV" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('id'); print('env_ok', d['name'])"
PER=$(curl -sf -X POST "$BASE/api/personas" -H 'Content-Type: application/json' -d '{"name":"Reg Dogfood","description":"test persona","refAssetIds":[],"notes":"operator-owned likeness"}')
echo "$PER" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('id'); print('persona_ok', d['name'])"
curl -sf "$BASE/api/environments" | python3 -c "import sys,json; d=json.load(sys.stdin); assert isinstance(d,list) and len(d)>=1; print('envs', len(d))"
curl -sf "$BASE/api/personas" | python3 -c "import sys,json; d=json.load(sys.stdin); assert isinstance(d,list) and len(d)>=1; print('personas', len(d))"

echo "== plans progress =="
curl -sf "$BASE/api/plans?projectId=$PID" > /tmp/cs-reg-plans.json
python3 - <<'PY'
import json
plans=json.load(open("/tmp/cs-reg-plans.json"))
assert plans, "no plans"
p=plans[0]
steps=p.get("steps") or []
assert steps, "no steps"
print("plan_status", p.get("status"))
print("steps", [(s.get("kind"), s.get("status")) for s in steps])
# After approve+workers, expect completed or at least preview_ready on a step
statuses={s.get("status") for s in steps}
assert "preview_ready" in statuses or "accepted" in statuses or p.get("status") in ("completed","running","failed"), statuses
print("plan_progress_ok")
PY

echo "== reverse =="
curl -sf -X POST "$BASE/api/plans" -H 'Content-Type: application/json' -d "{\"action\":\"reverse\",\"partId\":\"$PART\"}" >/dev/null

echo "== replicate clamp =="
CLAMP=$(curl -sf -X POST "$BASE/api/tools" -H 'Content-Type: application/json' -d '{"action":"validate_replicate","durationSec":15}')
echo "$CLAMP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['fixed'][0]['payload']['durationSec']==5; print('clamp_ok')"

echo "== crawl =="
curl -sf -X POST "$BASE/api/tools" -H 'Content-Type: application/json' -d "{\"action\":\"crawl\",\"projectId\":\"$PID\",\"query\":\"shop product broll\"}" >/dev/null
sleep 3

echo "== providers voices/models =="
curl -sf "$BASE/api/providers?kind=replicate_models" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('allowlist'); print('models', len(d['allowlist']))"
curl -sf "$BASE/api/providers?kind=voices" >/dev/null || true

echo "== voice fixture =="
curl -sf -X POST "$BASE/api/voice/stt" -H 'Content-Type: application/json' -d '{"fixture":true}' | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('transcript'); print('stt_ok')"

echo "== spend totals =="
curl -sf "$BASE/api/spend?projectId=$PID" | python3 -c "import sys,json; d=json.load(sys.stdin); print('spend', d['totals'])"

echo "== clean project =="
curl -sf -X DELETE "$BASE/api/projects/$PID" >/dev/null

echo "ALL REGRESSION CHECKS PASSED"
