#!/usr/bin/env bash
# Smoke: studio controls (scene objects, camera path, lights, visibility, animation)
set -euo pipefail
BASE="${BASE_URL:-http://localhost:2980}"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK  $*"; }

echo "== health =="
curl -sf "$BASE/" >/dev/null || fail "web not up on $BASE"
ok "web"

echo "== create project =="
PROJ=$(curl -sf -X POST "$BASE/api/projects" -H 'Content-Type: application/json' -d '{"name":"Studio Controls Smoke","clientName":"QA"}')
PID=$(echo "$PROJ" | python3 -c "import sys,json; print(json.load(sys.stdin)['project']['id'])")
PART=$(echo "$PROJ" | python3 -c "import sys,json; print(json.load(sys.stdin)['part']['id'])")
ok "project=$PID part=$PART"

echo "== ensure scene =="
SCENE=$(curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' -d "{\"partId\":\"$PART\",\"action\":\"ensure\"}")
echo "$SCENE" | python3 -c "import sys,json; s=json.load(sys.stdin)['scene']; assert s.get('version')==1; assert 'camera' in s; print('objects', len(s.get('objects') or []))"
ok "ensure"

echo "== upload image asset =="
python3 - <<'PY'
from struct import pack
import zlib
def chunk(tag, data):
    return pack(">I", len(data)) + tag + data + pack(">I", zlib.crc32(tag + data) & 0xffffffff)
raw = b"\x00" + b"\xff\x00\x00" * 8
ihdr = pack(">IIBBBBB", 8, 1, 8, 2, 0, 0, 0)
open("/tmp/studio-smoke.png","wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
PY
ASSET=$(curl -sf -X POST "$BASE/api/assets" -F "file=@/tmp/studio-smoke.png;type=image/png" -F "projectId=$PID" -F "notes=smoke plane")
AID=$(echo "$ASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
ok "asset=$AID"

echo "== place with drop position =="
PLACE=$(curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' \
  -d "{\"partId\":\"$PART\",\"action\":\"place\",\"assetIds\":[\"$AID\"],\"position\":{\"x\":1.25,\"y\":-0.5,\"z\":1.1}}")
OID=$(echo "$PLACE" | python3 -c "
import sys,json
s=json.load(sys.stdin)['scene']
assert len(s['objects'])==1
o=s['objects'][0]
assert abs(o['position']['x']-1.25)<1e-6
assert abs(o['position']['y']+0.5)<1e-6
assert o.get('visible', True) is True
assert abs(float(o.get('opacity',1))-1)<1e-6
print(o['id'])
")
ok "place oid=$OID"

echo "== updateObject props + visibility + timeline + animation =="
UPD=$(curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' -d "{
  \"partId\": \"$PART\",
  \"action\": \"updateObject\",
  \"objectId\": \"$OID\",
  \"position\": {\"x\": 0.33, \"y\": -1.2, \"z\": 0.9},
  \"rotation\": {\"x\": 0, \"y\": 15.5, \"z\": 0},
  \"scale\": {\"x\": 1.2, \"y\": 1, \"z\": 1.2},
  \"opacity\": 0.45,
  \"visible\": true,
  \"timelineRange\": {\"inSec\": 0.5, \"outSec\": 4.0},
  \"animation\": {
    \"loop\": true,
    \"keyframes\": [
      {\"t\": 0, \"opacity\": 0.2, \"position\": {\"x\": 0.33, \"y\": -1.2, \"z\": 0.9}},
      {\"t\": 2, \"opacity\": 1.0, \"position\": {\"x\": 0.33, \"y\": -1.2, \"z\": 1.5}}
    ]
  }
}")
echo "$UPD" | python3 -c "
import sys,json
o=json.load(sys.stdin)['scene']['objects'][0]
assert abs(o['position']['x']-0.33)<1e-6
assert abs(o['rotation']['y']-15.5)<1e-6
assert abs(o['opacity']-0.45)<1e-6
assert o['timelineRange']['inSec']==0.5
assert o['animation']['loop'] is True
assert len(o['animation']['keyframes'])==2
print('opacity', o['opacity'], 'keys', len(o['animation']['keyframes']))
"
ok "updateObject"

echo "== clear timelineRange =="
CLR=$(curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' \
  -d "{\"partId\":\"$PART\",\"action\":\"updateObject\",\"objectId\":\"$OID\",\"timelineRange\":null}")
echo "$CLR" | python3 -c "import sys,json; o=json.load(sys.stdin)['scene']['objects'][0]; assert o.get('timelineRange') in (None, {}); print('cleared')"
ok "clear timelineRange"

echo "== light add + update =="
LIT=$(curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' \
  -d "{\"partId\":\"$PART\",\"action\":\"light\",\"color\":\"#ffcc00\",\"intensity\":600,\"position\":{\"x\":2,\"y\":-2,\"z\":4}}")
LID=$(echo "$LIT" | python3 -c "import sys,json; ls=json.load(sys.stdin)['scene']['lights']; assert ls; print(ls[-1]['id'])")
LIT2=$(curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' \
  -d "{\"partId\":\"$PART\",\"action\":\"updateLight\",\"lightId\":\"$LID\",\"color\":\"#00ffaa\",\"intensity\":900,\"position\":{\"x\":1.5,\"y\":-1,\"z\":3.5}}")
echo "$LIT2" | python3 -c "
import sys,json
l=next(x for x in json.load(sys.stdin)['scene']['lights'] if x['id']=='$LID')
assert l['color']=='#00ffaa'
assert abs(float(l['intensity'])-900)<1e-6
assert abs(l['position']['x']-1.5)<1e-6
print('light', l['id'], l['intensity'])
"
ok "lights"

echo "== precise camera pose =="
CAM=$(curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' \
  -d "{\"partId\":\"$PART\",\"action\":\"camera\",\"notePath\":false,\"camera\":{\"position\":{\"x\":0.33,\"y\":-5.25,\"z\":2.1},\"target\":{\"x\":0.1,\"y\":0.2,\"z\":1.05},\"fov\":38.5}}")
echo "$CAM" | python3 -c "
import sys,json
c=json.load(sys.stdin)['scene']['camera']
assert abs(c['position']['x']-0.33)<1e-6
assert abs(c['target']['y']-0.2)<1e-6
assert abs(c['fov']-38.5)<1e-6
print('cam', c['position'], 'look', c['target'], 'fov', c['fov'])
"
ok "camera pose"

echo "== camera track + chat path note =="
BEFORE=$(curl -sf "$BASE/api/chat?projectId=$PID" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
TRACK=$(curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' -d "{
  \"partId\": \"$PART\",
  \"action\": \"camera\",
  \"camera\": {
    \"track\": [
      {\"t\": 0, \"position\": {\"x\": 0, \"y\": -6, \"z\": 2}, \"target\": {\"x\": 0, \"y\": 0, \"z\": 1}, \"fov\": 40},
      {\"t\": 2.5, \"position\": {\"x\": 1, \"y\": -4, \"z\": 2.2}, \"target\": {\"x\": 0, \"y\": 0, \"z\": 1}, \"fov\": 35},
      {\"t\": 5.0, \"position\": {\"x\": 2, \"y\": -3, \"z\": 2.5}, \"target\": {\"x\": 0.2, \"y\": 0, \"z\": 1.1}, \"fov\": 32}
    ]
  }
}")
echo "$TRACK" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d.get('pathNoted') is True
tr=d['scene']['camera']['track']
assert len(tr)==3 and abs(tr[-1]['t']-5.0)<1e-6
print('track_keys', len(tr), 'dur', tr[-1]['t'])
"
sleep 0.4
AFTER=$(curl -sf "$BASE/api/chat?projectId=$PID")
echo "$AFTER" | python3 -c "
import sys,json
msgs=json.load(sys.stdin)
assert len(msgs) > int('$BEFORE'), (len(msgs), '$BEFORE')
hit=next((m for m in msgs if (m.get('meta') or {}).get('kind')=='camera_path' or 'Camera path recorded' in (m.get('content') or '')), None)
assert hit, 'expected camera path chat message'
assert '\"t\":' in hit['content'] or 'keyframes' in hit['content'].lower()
print('chat_path_ok', hit['role'], 'meta', (hit.get('meta') or {}).get('kind'))
"
ok "camera path chat"

echo "== video timing on video object =="
if command -v ffmpeg >/dev/null; then
  ffmpeg -y -f lavfi -i testsrc=duration=1:size=160x120:rate=10 -c:v libx264 -pix_fmt yuv420p /tmp/studio-smoke.mp4 >/tmp/studio-smoke-ff.log 2>&1 || true
fi
if [[ -f /tmp/studio-smoke.mp4 ]]; then
  VASSET=$(curl -sf -X POST "$BASE/api/assets" -F "file=@/tmp/studio-smoke.mp4;type=video/mp4" -F "projectId=$PID" -F "notes=smoke video")
  VID=$(echo "$VASSET" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
  VPLACE=$(curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' \
    -d "{\"partId\":\"$PART\",\"action\":\"place\",\"assetIds\":[\"$VID\"],\"position\":{\"x\":-1,\"y\":0,\"z\":1.2}}")
  VOID=$(echo "$VPLACE" | python3 -c "import sys,json; objs=json.load(sys.stdin)['scene']['objects']; print([o['id'] for o in objs if o['kind']=='video'][0])")
  VT=$(curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' \
    -d "{\"partId\":\"$PART\",\"action\":\"updateObject\",\"objectId\":\"$VOID\",\"videoTiming\":{\"startOffset\":1.25,\"playbackSpeed\":1.5}}")
  echo "$VT" | python3 -c "
import sys,json
o=next(x for x in json.load(sys.stdin)['scene']['objects'] if x['id']=='$VOID')
assert abs(o['videoTiming']['startOffset']-1.25)<1e-6
assert abs(o['videoTiming']['playbackSpeed']-1.5)<1e-6
print('videoTiming', o['videoTiming'])
"
  ok "videoTiming"
else
  echo "SKIP videoTiming (no ffmpeg sample)"
fi

echo "== render payload includes new fields =="
REND=$(curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' \
  -d "{\"partId\":\"$PART\",\"action\":\"render\"}")
PLAN=$(echo "$REND" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('planId'); print(d['planId'])")
# cancel by not approving — just verify plan step payload shape via DB API
curl -sf "$BASE/api/plans?projectId=$PID" | python3 -c "
import sys,json
plans=json.load(sys.stdin)
p=next(x for x in plans if x['id']=='$PLAN')
step=next(s for s in p['steps'] if s['kind']=='blender')
payload=step.get('payload') or {}
objs=payload.get('objects') or []
assert objs, payload
o=objs[0]
for key in ('opacity','visible','animation','position','rotation','scale'):
    assert key in o, (key, o.keys())
print('render_payload_ok', 'frames', payload.get('frames'), 'obj_keys', sorted(o.keys()))
"
ok "render payload"

echo "== remove light + object =="
curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' \
  -d "{\"partId\":\"$PART\",\"action\":\"remove\",\"lightId\":\"$LID\"}" | python3 -c "
import sys,json
s=json.load(sys.stdin)['scene']
assert all(l['id']!='$LID' for l in s['lights'])
print('light_removed')
"
curl -sf -X PATCH "$BASE/api/projects/$PID/scene" -H 'Content-Type: application/json' \
  -d "{\"partId\":\"$PART\",\"action\":\"remove\",\"objectId\":\"$OID\"}" | python3 -c "
import sys,json
s=json.load(sys.stdin)['scene']
assert all(o['id']!='$OID' for o in s['objects'])
print('object_removed', 'remaining', len(s['objects']))
"
ok "remove"

echo "== unit tests =="
(cd apps/web && npx vitest run src/lib/scene/scene.test.ts) || fail "unit tests"
ok "vitest scene"

echo "== clean =="
curl -sf -X DELETE "$BASE/api/projects/$PID" >/dev/null
ok "cleaned"

echo
echo "ALL STUDIO CONTROLS SMOKE CHECKS PASSED"
