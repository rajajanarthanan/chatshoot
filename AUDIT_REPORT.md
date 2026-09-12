# Chatshoot Project Audit Report
## Date: 2026-09-11

### Executive Summary
The project has a solid foundation but suffers from several systemic issues that make it feel "basic and full of bugs." The core architecture is sound, but the implementation has accumulated workarounds, unclear logic, and incomplete flows.

---

## Critical Issues

### 1. **Agent Prompt Complexity** ❌
**Location**: `apps/web/src/lib/agents/lead.ts`
**Problem**: The system prompt is extremely long (>100 lines) with multiple conditional instructions mixed together. This creates confusion and inconsistent behavior.

**Symptoms**:
- Agent sometimes doesn't ask clarifying questions when it should
- Unclear when to use `revise_part` vs `revise_timeline` vs `create_production_plan`
- Cost estimation confusion (GenFill triggers)

**Solution**: Simplify and restructure the prompt with clear decision trees.

---

### 2. **Footage Edit Routing is Hacky** ❌
**Location**: `apps/web/src/lib/agents/lead.ts` (line 484-503)
**Problem**: The `revise_timeline` tool checks for spatial edits (stack/crop) and then calls `createPlanFromBrief` as a workaround. This is architecturally wrong.

```typescript
// HACK: Timeline split does not restack pixels — route that intent to footage edit
if (spatial.edits.stackHalvesTb || spatial.edits.crop916) {
  const plan = await createPlanFromBrief({...});
  // ... this should be a separate tool!
}
```

**Solution**: The agent should call `revise_part` directly for spatial edits, not `revise_timeline`.

---

### 3. **Overly Broad Regex Patterns** ⚠️
**Location**: `apps/web/src/lib/brief/parse.ts` (line 58)
**Problem**: The `stackHalvesTb` regex is too permissive:

```typescript
const stackHalvesTb =
  /top.{0,60}bottom|bottom.{0,60}top|one (at |on )?the top|stack\s*(them|the|two|halves|it)|...
```

This will match phrases like "top performer at the bottom of the list" or "one at the top of the page."

**Solution**: Make regexes more specific and require video/clip/layout context.

---

### 4. **Linting Errors** ⚠️
**Locations**: 
- `apps/web/src/lib/plan/machine.ts:154` - `logo` should be const
- `apps/web/src/lib/timeline/adapters.ts:298` - `tl` should be const

**Solution**: Fix these immediately as they indicate careless coding.

---

### 5. **GenFill Trigger Logic Still Complex** ⚠️
**Location**: `apps/web/src/lib/plan/machine.ts` (line 98-104)
**Problem**: The `wantsGenFill` function has negative lookahead but still might have edge cases.

```typescript
function wantsGenFill(brief: string, opts: { personaId?: string; wantGenfill?: boolean }) {
  if (/\bno\s+gen[\s-]?fill\b/i.test(brief) && !opts.personaId) return false;
  if (opts.personaId || opts.wantGenfill) return true;
  return /\b(gen[\s-]?fill|ai\s*clip|image[\s-]?to[\s-]?video|run\s+persona|...)\b/i.test(brief);
}
```

The problem: What if user says "I don't want genfill" with different phrasing?

**Solution**: Make this more robust with better negative phrase detection.

---

### 6. **React Hook Dependency Warning** ⚠️
**Location**: `apps/web/src/app/projects/[id]/page.tsx:139`
**Problem**: Missing `part` in useMemo deps could cause stale data.

**Solution**: Add proper dependencies or use a different memoization strategy.

---

### 7. **Incomplete Gallery Selection Flow** ⚠️
**Location**: Various files
**Problem**: While the UI has multi-select, it's unclear if the full flow works:
1. User selects assets in gallery ✓
2. Assets are passed to chat ✓
3. Agent receives selectedIds ✓
4. Agent uses them correctly ❓
5. Plan shows which assets were used ❓

**Solution**: Add explicit asset tracking throughout the pipeline.

---

### 8. **Agent Tool Confusion** ❌
**Problem**: The agent has THREE tools for creating/revising work:
- `create_production_plan` - Full new plans
- `revise_part` - VO/copy/footage edits
- `revise_timeline` - Time-based clip ops

The boundaries are unclear, leading to the agent calling the wrong tool.

**Current guidance**:
> "When revising layout/stack/trim (left/right halves stacked vertically, crop 9:16, trim in/out), call revise_part — that ffmpeg-edits the footage."

But then `revise_timeline` ALSO checks for these and redirects to `createPlanFromBrief`!

**Solution**: Clarify tool boundaries and remove the hacky workaround.

---

## Medium Issues

### 9. **No End-to-End Validation** ⚠️
**Problem**: We don't know if common user flows actually work:
- Upload video → Stack vertically → Export
- Select 3 clips → "Make a 20s video" → Approve → Export
- "Add voiceover about X" → Approve → Works?

**Solution**: Create integration tests or manual test checklist.

---

### 10. **Cost Estimation Not Visible During Plan** ⚠️
**Problem**: User sees cost after the plan is created, but not during asset selection or prompt writing.

**Solution**: Show estimated cost preview based on selected assets and brief keywords.

---

### 11. **No Clear Error Messages** ⚠️
**Problem**: When things fail, users don't know why:
- "Plan failed" - what step? why?
- "GenFill triggered" - why? how to avoid?
- "Edit not applied" - what was the intent?

**Solution**: Add user-friendly error messages and fallback suggestions.

---

### 12. **Plate vs Clip Terminology Confusion** ⚠️
**Problem**: The code uses "plate" (Blender output), "broll" (footage), "clip" (timeline element) inconsistently.

**Solution**: Standardize terminology in UI, code, and docs.

---

## Minor Issues

### 13. **Unused Imports** ℹ️
Multiple files have unused imports flagged by ESLint.

**Solution**: Run `npm run lint -- --fix` or remove manually.

---

### 14. **Inconsistent Null Handling** ℹ️
Some places use `|| null`, others use `?? null`, others use `undefined`.

**Solution**: Standardize on `?? null` for consistency.

---

### 15. **Magic Numbers** ℹ️
```typescript
const slice = Math.max(1, Math.floor(durationInFrames / lines.length));
```
No explanation of why these specific values.

**Solution**: Extract to named constants with comments.

---

## Architecture Gaps

### 16. **No Undo/Redo Beyond "Reverse Last"** ⚠️
Users can only reverse the last step, not arbitrary steps or see full history.

**Solution**: Add plan history view and selective reverse.

---

### 17. **No Asset Preview in Chat Context** ⚠️
When user selects assets, the agent sees IDs but not thumbnails or visual context.

**Solution**: Pass asset metadata (dimensions, duration, dominant colors) to agent.

---

### 18. **No Batch Operations** ℹ️
User can't select multiple clips and delete/trim/reorder them together.

**Solution**: Add batch clip operations in UI.

---

## Testing Gaps

### 19. **No Unit Tests for Parse Logic** ❌
The `parseBrief` function has complex regex logic but no tests.

**Solution**: Add unit tests for common phrases and edge cases.

---

### 20. **No Integration Tests for Agent Flow** ❌
We don't test the full agent → plan → worker → preview flow.

**Solution**: Add integration tests or improve `regression.sh`.

---

## Recommendations

### Immediate Fixes (Today)
1. ✅ Fix linting errors (`logo` and `tl` const)
2. ✅ Simplify agent system prompt
3. ✅ Remove the hacky spatial edit check from `revise_timeline`
4. ✅ Make `parseBrief` regexes more specific
5. ✅ Fix React hook dependency warning

### Short-term (This Week)
1. Add unit tests for `parseBrief`
2. Create end-to-end test checklist
3. Improve error messages in UI
4. Add asset metadata to agent context
5. Standardize terminology

### Medium-term (Next Sprint)
1. Add plan history and selective undo
2. Add cost preview before plan creation
3. Add batch clip operations
4. Create user onboarding flow
5. Add visual asset preview in chat

---

## Conclusion

The project is **not fundamentally broken**, but it suffers from:
1. **Accumulated technical debt** (workarounds, unclear logic)
2. **Incomplete user flows** (missing error states, unclear feedback)
3. **Overly complex prompts** (agent confusion)
4. **Lack of validation** (no tests, no clear success criteria)

**Priority**: Fix the agent prompt and tool routing first, as these cause the most user-facing issues. Then add proper testing to prevent regressions.
