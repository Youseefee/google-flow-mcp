---
version: 2.0.0
name: google-flow-generate
description: |
  Generate images and video using a Google AI Pro subscription via Google Flow
  (labs.google/flow), driven by browser automation (the google-flow MCP server),
  to avoid paying per-credit services for what Google already covers. Use when the
  user asks to generate an image or video and no specific other service is named.
  Images are effectively free (they do not draw down the monthly Flow credit pool);
  video consumes credits.
allowed-tools: Bash, PowerShell, flow_generate_image, flow_generate_video, SendUserFile, Read
---

# Google Flow Generate — Fast One-Shot Workflow

Generate images/video on Google Flow through the `google-flow` MCP server with minimum latency.

## ⚡ FAST PATH (Default — 1 Single Step)

The MCP server auto-connects to the dedicated Chrome instance automatically. **Do NOT run PowerShell or flow_connect first unless an error occurs.**

### 1. Build a rich prompt
Enrich the user's intent with supporting details (subject + action + setting + lighting + composition + style + mood + quality cues). Do not invent unwanted objects/text. Match `ratio` (16:9 scene, 9:16 portrait/story, 1:1 square).

### 2. Generate Image immediately
Call `flow_generate_image` directly in the very first turn:
- `prompt`: The enriched prompt
- `auto_confirm`: `true`
- `model`: `Nano Banana 2 Lite` (default, fastest, 0 credits), `Nano Banana 2` (~5-8s) or `Nano Banana Pro` (complex high fidelity)
- `ratio`: requested ratio (default `16:9` or `1:1`)

### 3. Deliver — no re-read, no screenshots
Immediately when `flow_generate_image` succeeds:
1. Call `SendUserFile` with `display: 'render'` to show the image directly in the chat panel:
   ```json
   { "files": [result.files[0]], "display": "render", "status": "normal", "caption": "..." }
   ```
2. Do NOT open with `Read`/vision, do NOT take screenshots, do NOT re-fetch the file. Deliver as-is for max speed. Regenerate only if user explicitly asks.

---

## 🎥 Video Generation (⚠️ Consumes Credits)

- Video consumes Google Flow credits (Veo 3.1 Lite ~10, Fast ~20, Quality ~100; Omni Flash ~15-30).
- Confirm credit spend with the user if not explicitly authorized.
- Call `flow_generate_video` with `auto_confirm: true`.
- Once downloaded, deliver via `SendUserFile`.

---

## 🛠️ RECOVERY PATH (Only if Direct Call Fails)

Only trigger this if `flow_generate_image` fails with `BROWSER_NOT_CONNECTED` or `FLOW_PAGE_NOT_FOUND`:

1. Run ensure script:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\ensure-flow-chrome.ps1"
   ```
2. Call `flow_connect`.
3. If `status: oauth_required`, tell the user to click "Sign in to Flow" once in the Chrome window.
4. Retry generation.
