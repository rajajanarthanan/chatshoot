# Chatshoot End-to-End Test Checklist

## Test Environment Setup
- [ ] Docker services running (postgres, redis)
- [ ] App running on http://localhost:2980
- [ ] Workers running (remotion, blender, ingest)
- [ ] Fresh test project created

---

## Core User Flows

### Flow 1: Upload and Basic Edit
**Goal**: Upload a video, stack it vertically, export

1. [ ] Create new project "TestFlow1"
2. [ ] Upload a 16:9 side-by-side video (e.g., two-person interview)
3. [ ] Wait for ingest to complete (transcript/caption)
4. [ ] Select the uploaded clip in gallery
5. [ ] Chat: "Stack the video vertically with one person on top and the other on bottom"
6. [ ] Verify plan shows:
   - `revise_part` (not `revise_timeline`)
   - Remotion step with `edits.stackHalvesTb: true`
   - Cost estimate ~$0.50 or less (should NOT trigger GenFill)
7. [ ] Approve plan
8. [ ] Wait for preview to update
9. [ ] Verify live preview shows:
   - Top half: left side of original
   - Bottom half: right side of original
10. [ ] Export MP4
11. [ ] Download and verify exported file

**Success Criteria**:
- ✅ Stack applied correctly
- ✅ No GenFill triggered
- ✅ Export playable
- ✅ Cost < $0.50

---

### Flow 2: Multi-Clip Freeform Timeline
**Goal**: Select 3 clips, create a video

1. [ ] Create new project "TestFlow2"
2. [ ] Upload 3 different assets (mix of video/images)
3. [ ] Select all 3 in gallery
4. [ ] Chat: "Make a 20-second video from these clips"
5. [ ] Verify plan shows:
   - `create_production_plan`
   - Freeform timeline (not SaaS kit)
   - 3 V1 clips
   - Cost estimate < $1.00
6. [ ] Approve plan
7. [ ] Wait for preview
8. [ ] Verify timeline shows all 3 clips
9. [ ] Click each clip in timeline strip
10. [ ] Verify player seeks to that clip

**Success Criteria**:
- ✅ All 3 clips used
- ✅ Freeform (not kit) structure
- ✅ Timeline scrubbing works
- ✅ Duration ~20s

---

### Flow 3: Add Voiceover
**Goal**: Add narration to existing video

1. [ ] Use project from Flow 2
2. [ ] Chat: "VO: This is a demo of our amazing product. Try it today."
3. [ ] Verify plan shows:
   - `revise_part` (not full plan)
   - TTS step only
   - Keeps existing visuals
4. [ ] Approve
5. [ ] Wait for audio generation
6. [ ] Verify preview has audio
7. [ ] Verify captions appear
8. [ ] Export and verify MP4 has audio track

**Success Criteria**:
- ✅ VO added without recreating visuals
- ✅ Captions generated
- ✅ Lip-sync not triggered (cost < $0.20)

---

### Flow 4: Timeline Clip Operations
**Goal**: Split, trim, reorder clips using UI buttons

1. [ ] Use project from Flow 2
2. [ ] Click first clip in timeline
3. [ ] Click "Split clip" button
4. [ ] Verify plan is auto-approved ($0 cost)
5. [ ] Verify timeline now shows 4 clips (first was split)
6. [ ] Select the 2nd clip
7. [ ] Click "Trim −30%" button
8. [ ] Verify clip duration reduced in timeline
9. [ ] Select the 3rd clip
10. [ ] Click "Earlier" button
11. [ ] Verify clip moves left in timeline strip

**Success Criteria**:
- ✅ All operations apply instantly
- ✅ No cost charged
- ✅ Preview updates correctly

---

### Flow 5: SaaS Kit (Explicit)
**Goal**: Create a SaaS promo with kit structure

1. [ ] Create new project "TestFlow5"
2. [ ] Upload:
   - Logo image
   - Product screenshot
   - Background video/image
3. [ ] Set kit slots:
   - First asset → Logo
   - Second asset → Product
   - Third asset → B-roll
4. [ ] Chat: "Apply saas kit with Title: Amazing CRM, Subtitle: Manage your business, CTA: Start Free Trial"
5. [ ] Verify plan shows:
   - `create_production_plan` with `kit: "saas_promo"`
   - 4 beats: logo → product → broll → cta
6. [ ] Approve
7. [ ] Verify preview has:
   - Logo sequence at start
   - Product shot with title overlay
   - B-roll with subtitle
   - CTA button at end
8. [ ] Verify beat strip shows 4 labeled beats

**Success Criteria**:
- ✅ Kit structure applied
- ✅ All 4 beats visible
- ✅ Assets mapped correctly

---

### Flow 6: Agent Clarification
**Goal**: Verify agent asks questions when ambiguous

1. [ ] Create new project "TestFlow6"
2. [ ] Upload 5 different video clips (don't select any)
3. [ ] Chat: "Make a video"
4. [ ] Verify agent responds with question like:
   - "Which clips would you like to use?"
   - "How long should the video be?"
   - "Do you want voiceover?"
5. [ ] Chat: "Use clips 1, 2, and 3"
6. [ ] Verify agent asks more questions OR says to select them in gallery
7. [ ] Select 3 clips
8. [ ] Chat: "Make a 15-second video"
9. [ ] Verify plan is created (not more questions)

**Success Criteria**:
- ✅ Agent asks clarifying questions
- ✅ Multi-turn conversation works
- ✅ Agent creates plan only when clear

---

### Flow 7: GenFill Explicit Trigger
**Goal**: Verify GenFill only runs when explicitly requested

1. [ ] Create new project "TestFlow7"
2. [ ] Upload a single image
3. [ ] Chat: "Make a 5-second video"
4. [ ] Verify plan does NOT include Replicate/GenFill
5. [ ] Verify cost < $0.50
6. [ ] Create new project "TestFlow7b"
7. [ ] Upload a single image
8. [ ] Chat: "Use genfill to animate this image into a 5-second video"
9. [ ] Verify plan DOES include Replicate step
10. [ ] Verify cost ~$0.50 - $1.50
11. [ ] Do NOT approve (to avoid actual cost)

**Success Criteria**:
- ✅ GenFill NOT triggered by default
- ✅ GenFill only when explicitly requested
- ✅ Cost estimates accurate

---

### Flow 8: Error States
**Goal**: Verify graceful error handling

1. [ ] Create new project "TestFlow8"
2. [ ] Chat: "Make a video" (with no assets)
3. [ ] Verify friendly error or clarification request
4. [ ] Upload a corrupt/invalid file
5. [ ] Verify error message explains issue
6. [ ] Create plan and let it fail (e.g., missing API key)
7. [ ] Verify plan shows "failed" status
8. [ ] Verify step shows which one failed
9. [ ] Click "Reverse last" to recover

**Success Criteria**:
- ✅ Errors explained clearly
- ✅ No cryptic messages
- ✅ Recovery path available

---

### Flow 9: Import from Gallery
**Goal**: Use production gallery assets

1. [ ] Create new project "TestFlow9"
2. [ ] Click "From gallery" button
3. [ ] Search for "nature" or "office"
4. [ ] Select 2 assets
5. [ ] Click "Import to project"
6. [ ] Verify assets appear in project gallery
7. [ ] Verify they're usable in timeline

**Success Criteria**:
- ✅ Global gallery accessible
- ✅ Assets import correctly
- ✅ No duplication in storage

---

### Flow 10: Cost Tracking
**Goal**: Verify spend is tracked accurately

1. [ ] Create new project "TestFlow10"
2. [ ] Note starting spend: $X.XX
3. [ ] Run a plan with TTS (estimated ~$0.15)
4. [ ] Wait for completion
5. [ ] Verify settled spend increased by ~$0.15
6. [ ] Run another plan with GenFill (estimated ~$0.50)
7. [ ] Approve but then kill the worker before completion
8. [ ] Verify pending spend shows correctly
9. [ ] Clean project
10. [ ] Verify spend history preserved

**Success Criteria**:
- ✅ Estimates accurate ±20%
- ✅ Settled matches actual API costs
- ✅ Pending cleared on completion/failure
- ✅ History survives clean

---

## Performance Checks

### Load Testing
- [ ] Project with 20+ assets loads in < 3s
- [ ] Timeline with 10+ clips renders smoothly
- [ ] Preview player doesn't stutter
- [ ] Gallery scroll is smooth

### Worker Health
- [ ] Remotion worker handles back-to-back jobs
- [ ] Blender worker completes without hanging
- [ ] Ingest worker processes uploads quickly
- [ ] Queue doesn't back up

---

## Regression Tests

Run `bash scripts/regression.sh` and verify all tests pass:
- [ ] Logo + product + broll kit compose
- [ ] Timeline beat revise ($0 cost)
- [ ] Blender plate into preview
- [ ] GenFill minimal segment
- [ ] TTS + captions

---

## Browser Compatibility
- [ ] Chrome/Edge (Chromium)
- [ ] Firefox
- [ ] Safari (if on Mac)
- [ ] Mobile responsive layout

---

## Completion Checklist

After all tests:
- [ ] No console errors in browser
- [ ] No worker crashes in logs
- [ ] Database connections stable
- [ ] Redis queue empty
- [ ] Media folder size reasonable
- [ ] All test projects can be cleaned

---

## Known Issues to Document

List any issues found but not yet fixed:
1. 
2. 
3. 

---

## Sign-Off

Tested by: _______________
Date: _______________
Version: _______________
All critical flows passed: ☐ Yes ☐ No

Notes:
