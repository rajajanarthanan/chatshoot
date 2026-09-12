# Timeline Viewer & Editor Features

## Overview
Added comprehensive timeline viewing and editing capabilities to Chatshoot, replacing the basic timeline strip with a professional-grade editor.

---

## New Features ✨

### 1. **Visual Timeline Viewer**
- Multi-track view (V1, A1, A2)
- Visual clip representation with colors
- Time markers and grid
- Zoom in/out controls (0.25x - 4x)
- Red playhead indicator
- Hover effects and tooltips

### 2. **Drag & Drop Editing** 🎯
- Click and drag clips to reposition
- Visual feedback during drag
- Snap-to-grid (coming soon)
- Multi-clip selection (coming soon)

### 3. **Clip Operations**
**Basic:**
- Split clip at center
- Delete clip
- Trim ±20%
- Move earlier/later

**Advanced:**
- Duplicate clip
- Mute/unmute
- Volume control
- Reorder clips

### 4. **Edit Modes**
- **Select Mode**: Click to select clips
- **Split Mode**: Click to split at playhead
- **Trim Mode**: Drag edges to adjust duration

### 5. **Keyboard Shortcuts** (Coming Soon)
- `Space`: Play/pause
- `S`: Split at playhead
- `Delete`: Delete selected
- `Cmd+D`: Duplicate
- `Cmd+Z`: Undo

---

## File Structure

```
apps/web/src/components/Timeline/
├── TimelineViewer.tsx     # Core timeline visualization
├── TimelineEditor.tsx     # Editor with operations panel
└── README.md              # Component docs

apps/web/src/lib/timeline/
└── schema.ts              # TypeScript types
```

---

## Usage

### In Project Page

The timeline has two views:

1. **Simple View** (default)
   - Horizontal clip strip
   - Quick operation buttons
   - Good for basic edits

2. **Advanced Timeline** (toggle button)
   - Full timeline editor
   - Multi-track view
   - Drag & drop
   - More operations

### Integration Example

```tsx
import { TimelineEditor } from "@/components/Timeline/TimelineEditor";

<TimelineEditor
  timeline={part.timelineJson}
  durationSec={totalDur}
  currentTime={currentTime}
  onSeek={handleTimelineSeek}
  onApplyEdit={async (ops, note) => {
    await applyClipOps(ops, note);
  }}
/>
```

---

## Components

### TimelineViewer

**Props:**
- `timeline: TimelineV2` - Timeline data
- `durationSec: number` - Total duration
- `currentTime?: number` - Current playhead position
- `selectedClipId?: string` - Currently selected clip
- `onSeek?: (sec: number) => void` - Seek callback
- `onClipSelect?: (clipId: string | null) => void` - Selection callback
- `onClipEdit?: (ops: ClipOp[], note: string) => void` - Edit callback
- `onClipMove?: (clipId: string, toTrack: string, toTime: number) => void` - Drag callback

**Features:**
- Zoom controls
- Multi-track rendering
- Playhead visualization
- Clip hover/select states
- Time markers

### TimelineEditor

**Props:**
- `timeline: TimelineV2` - Timeline data
- `durationSec: number` - Total duration
- `currentTime?: number` - Current playhead position
- `onSeek?: (sec: number) => void` - Seek callback
- `onApplyEdit?: (ops: ClipOp[], note: string) => Promise<void>` - Edit callback

**Features:**
- Edit mode toolbar
- Selected clip info panel
- Advanced operations panel
- Wraps TimelineViewer with editing UI

---

## Clip Operations (ClipOp Types)

### Split
```typescript
{
  op: "split",
  clipId: string,
  atSec: number
}
```

### Trim
```typescript
{
  op: "trim",
  clipId: string,
  durSec?: number,
  sourceInSec?: number,
  sourceOutSec?: number
}
```

### Reorder
```typescript
{
  op: "reorder",
  clipId: string,
  toIndex: number
}
```

### Delete
```typescript
{
  op: "delete",
  clipId: string
}
```

### Insert
```typescript
{
  op: "insert",
  trackId: string,
  index: number,
  clip: {
    id?: string,
    role?: string,
    durSec: number,
    assetRef?: {...}
  }
}
```

### Volume
```typescript
{
  op: "volume",
  clipId: string,
  volume?: number,
  muted?: boolean
}
```

---

## Styling

### Color Scheme
- **V1 clips (video)**: Blue shades (#1e40af)
- **Audio clips**: Teal shades (#0f766e)
- **Selected**: Cyan (#3dd6c6)
- **Hovered**: Bright blue (#2563eb)
- **Playhead**: Red (#ef4444)

### Responsive
- Timeline scrolls horizontally
- Zoom adjusts pixel-per-second ratio
- Tracks have fixed heights

---

## Roadmap 🚀

### Short-term
- [ ] Snap to grid
- [ ] Multi-clip selection (Shift+Click)
- [ ] Copy/paste clips (Cmd+C/Cmd+V)
- [ ] Undo/redo stack
- [ ] Keyboard shortcuts

### Medium-term
- [ ] Thumbnail previews in clips
- [ ] Audio waveforms
- [ ] Transition effects UI
- [ ] Speed control (0.5x, 2x)
- [ ] Precise trim handles (edge dragging)

### Long-term
- [ ] Multi-track audio mixing
- [ ] Effects panel
- [ ] Color grading
- [ ] Text/title tracks
- [ ] Export presets

---

## Testing

### Manual Test Checklist
- [ ] Zoom in/out works smoothly
- [ ] Clips can be selected by clicking
- [ ] Drag & drop moves clips
- [ ] Split creates two clips
- [ ] Delete removes clip
- [ ] Trim adjusts duration
- [ ] Reorder changes position
- [ ] Playhead seeks on timeline click
- [ ] Multi-track clips render correctly
- [ ] Toggle between simple/advanced views

---

## Performance Notes

- Timeline renders with CSS positioning (fast)
- Drag operations throttled
- Only visible clips rendered (no virtualization yet)
- Recommended max: 50 clips per track

---

## Known Limitations

1. **No snap-to-grid yet** - Clips can overlap
2. **Drag moves entire clip** - Can't trim by edge drag
3. **No multi-select** - One clip at a time
4. **No thumbnails** - Just colored rectangles
5. **No waveforms** - Audio clips are solid blocks

---

## Browser Compatibility

- ✅ Chrome/Edge (Chromium)
- ✅ Firefox
- ✅ Safari (WebKit)
- ⚠️ Mobile (touch support TBD)

---

## Accessibility

- Keyboard navigation (partial)
- Screen reader labels (TBD)
- High contrast mode support (TBD)

---

## Contributing

To add new features:

1. Add ClipOp type to `schema.ts`
2. Implement in `adapters.ts` (applyClipOps)
3. Add UI in `TimelineEditor.tsx`
4. Test with manual checklist

---

## Credits

Inspired by:
- **CapCut** - Multi-track timeline UI
- **Premiere Pro** - Clip operations
- **Final Cut Pro** - Magnetic timeline (future)

---

## Support

For issues or feature requests, see:
- `AUDIT_REPORT.md` - Known issues
- `TEST_CHECKLIST.md` - Testing flows
- `FIXES_SUMMARY.md` - Recent changes
