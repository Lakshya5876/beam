# S17 Contract: Build Deployable Viewer Artifact + Deploy Instructions

**Objective:** Build the viewer into a deployable artifact for CF Pages, write deploy instructions for the human to execute on a deploy-capable machine, and document all hard requirements. **NO deployment on this machine** — all wrangler/git push actions deferred.

**Scope:** Vite build configuration, CF Pages headers, wrangler deployment commands (documented, not run), deploy instructions.

---

## HARD REQUIREMENTS (Silent Failures at S18 if Missed)

### Requirement 1: Service-Worker-Allowed Header on /__beam/sw.js

**Why:** `bootstrap.ts` calls `navigator.serviceWorker.register('/__beam/sw.js', { scope: '/' })`. Without the response header `Service-Worker-Allowed: /`, Chrome throws a silent `SecurityError` at registration time. No stack trace, no fetch attempt — just a failed registration that breaks all relay functionality at S18.

**Implementation:** Create `viewer/public/_headers` (or Wrangler equivalent):
```
/__beam/sw.js
  Service-Worker-Allowed: /
```

**Verification:** 
- File exists at `viewer/public/_headers`.
- Header is exactly `Service-Worker-Allowed: /` (case-sensitive).
- Wrangler Pages route rule serves `viewer/public/` files with these headers applied to `/__beam/sw.js`.

---

### Requirement 2: /__beam/ Path Prefix Consistency

**Why:** The path exclusion in `sw.ts` is hardcoded: `if (url.pathname.startsWith('/__beam/')) return;`. This exclusion ensures Beam's own bootstrap assets (the SW itself, the main bundle) pass through to the network rather than being tunneled over WebRTC. If the Pages route serves these assets from a different path prefix, the exclusion rule is wrong and the SW will try to relay its own JS over the data channel — a silent logic error at S18.

**Implementation:**

**Vite output paths** (`viewer/vite.config.ts` — already correct):
- `sw.js` → `dist/sw.js` (fixed, no hash)
- `main-*.js` → `dist/assets/main-*.js` (hashed)
- `index.html` → `dist/index.html`

**Wrangler Pages route** (in `wrangler.toml` or Pages config):
- Serve `viewer/dist/` at root (`/`).
- **Critical**: Assets under `dist/` must be served with their relative paths preserved.
  - `dist/sw.js` → accessible at `/__beam/sw.js` (i.e., Pages root must mount at `/__beam/`, NOT `/`).
  - OR: Vite must output to `dist/__beam/sw.js` and Wrangler serves `viewer/dist/` at `/`, so `dist/__beam/sw.js` → `/__beam/sw.js`.

**Option A (Recommended):** Wrangler Pages config routes the viewer to a sub-path:
```
routes = [
  { pattern = "beam-viewer.pages.dev", zone_id = "..." },
]
# And Pages serves viewer/dist/ at /__beam/, so dist/sw.js → /__beam/sw.js
```

**Option B (Alternative):** Vite outputs to a `__beam/` sub-directory:
```ts
// vite.config.ts
output: {
  dir: 'dist/__beam/',
  entryFileNames: (chunk) => chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
}
// bootstrap.ts then calls register('/__beam/sw.js', { scope: '/__beam/' })
```
*(This option requires changing bootstrap.ts scope, complicating the SW exclusion rule.)*

**Verification:**
- After `npm run build --prefix viewer`, verify the output structure matches the served path.
- Check `index.html` has correct relative paths to assets (e.g., `<script src="/assets/main-*.js"></script>` if served at root, or `<script src="/__beam/assets/..."></script>` if sub-pathed).
- Confirm `sw.ts` exclusion rule `startsWith('/__beam/')` matches the deployed path exactly.

---

## DELIVERABLES

### 1. Vite Build Artifact

**Command:** `npm run build --prefix viewer`

**Outputs:**
- `viewer/dist/sw.js` (fixed filename, no hash) — the SW entry
- `viewer/dist/assets/main-*.js` (hashed) — the main bundle
- `viewer/dist/assets/*.css` (if any styles)
- `viewer/dist/index.html` — the root HTML

**Verification after build:**
- `ls viewer/dist/` shows expected structure
- `viewer/dist/sw.js` exists (not hashed)
- `viewer/dist/index.html` references correct asset paths (using relative URLs if served at root, or absolute URLs matching the /__beam/ prefix if sub-pathed)
- File sizes reasonable (sw.js ~5–10 KiB after minification; main-*.js ~50–100 KiB depending on bundler tree-shaking)

### 2. CF Pages _headers File

**File:** `viewer/public/_headers`

**Content:**
```
/__beam/sw.js
  Service-Worker-Allowed: /
  Cache-Control: max-age=3600

/
  Cache-Control: max-age=0, no-cache
```

*(SW should not be cached indefinitely; index.html should not be cached to allow live updates; sw.js itself should cache briefly for performance but be revalidated.)*

**Verification:**
- File exists and is readable.
- Syntax is valid (no typos in header names).
- Service-Worker-Allowed is present and exactly `/`.

### 3. Deploy Instructions Document

**File:** `DEPLOY.md` (new, or append to README.md)

**Content must include:**

#### Section A: Prerequisites
- Node >= 22
- `npm` installed
- `wrangler` CLI installed (`npm install -g @cloudflare/wrangler` or via project)
- Cloudflare account with Pages project created

#### Section B: Environment Variables
- `SIGNALING_BASE_URL` — the URL to the signaling Worker (e.g., `https://beam-signal.workers.dev`)
- Where to set: Wrangler Pages environment config (`.dev.vars` or Pages dashboard)

#### Section C: Build Steps
```bash
# Build the viewer
npm run build --prefix viewer

# Output: viewer/dist/ contains deployable files
```

#### Section D: Wrangler Deploy (Not Run Here)
```bash
# Deploy signaling server (if changed)
wrangler deploy --config signaling/wrangler.toml

# Deploy viewer to Pages (run from the repo root on a deploy machine)
wrangler pages deploy viewer/dist/ --project-name beam-viewer --branch main
```

**Notes in deploy instructions:**
- "Run these commands from a deploy-capable machine (not this laptop)."
- "Ensure the Pages _headers file is deployed with the viewer (`viewer/public/_headers` is copied to `viewer/dist/_headers` by Wrangler)."
- "Verify Service-Worker-Allowed header is present: `curl -I https://beam-viewer.pages.dev/__beam/sw.js | grep Service-Worker`"

#### Section E: Verification After Deploy
- Navigate to `https://beam-viewer.pages.dev/?session=test` — should render "Unsupported" or "Connecting" (not error 404/500).
- Check browser console for no CORS or registration errors.
- Inspect Network tab: `__beam/sw.js` should have `Service-Worker-Allowed: /` header.

---

## VERIFICATION (without deploying)

### Step 1: Build the Viewer
```bash
npm run build --prefix viewer
```
- Expect: `viewer/dist/` directory with `sw.js`, `assets/main-*.js`, `index.html`
- Check: `ls -lh viewer/dist/` shows expected files

### Step 2: Verify Asset Paths in index.html
```bash
grep -o 'src="[^"]*"' viewer/dist/index.html
```
- Expect: Paths like `src="/assets/main-<hash>.js"` or equivalent matching the /__beam/ prefix

### Step 3: Verify _headers File
```bash
cat viewer/public/_headers
```
- Expect: `/__beam/sw.js` section with `Service-Worker-Allowed: /`

### Step 4: Verify sw.ts Exclusion Rule
```bash
grep -A 2 '__beam' viewer/src/sw.ts
```
- Expect: `if (url.pathname.startsWith('/__beam/')) return;`

### Step 5: Lint and Type Check (no changes expected)
```bash
npx eslint --ignore-pattern 'viewer/dist/**' .
npx tsc --noEmit
npm --prefix viewer test
npx vitest run
```
- Expect: all green, same as S16

---

## SCOPE EXCLUSIONS (Deferred to Separate Session)

- **No `wrangler deploy` or `wrangler pages deploy`** — documented, not executed
- **No `git push`** — human does this from a plain shell
- **No changes to signaling Worker** — unless S16 changes require it (not expected)
- **No changes to core package** — this is a viewer-only sprint

---

## S18 Sequencing Notes (for the next contract)

When you write the S18 contract, flag these two items for integration verification:

### Item 1: RTCDataChannel Frame Size vs 16 KiB Interop Ceiling

The N7 test verified frame arithmetic: `encodeFrame(frame).byteLength === payload.byteLength + 9`. But the frame size is `MAX_PAYLOAD_SIZE (256 KB) + 9`, which far exceeds the RTCDataChannel's ~16 KiB per-message interop ceiling in Chromium/Firefox.

**Check at S18:**
- Does `BrowserDataChannelAdapter.send(frame)` handle frames larger than 16 KiB?
  - If the browser buffers internally (chrome does, up to a point), what's the actual limit?
  - If we're sending a 256 KB frame, does it split internally, or fail silently?
- Real integration test: send a request with a 200 KB body, verify it reassembles correctly on the other side.
- If frames exceed the channel's hard limit, the design needs adjustment (smaller MAX_PAYLOAD_SIZE, or pre-chunking in the adapter).

### Item 2: mux.openStreamIds() Accessor vs Viewer Wrapper

The C2 fix added `ViewerConnection.openStreamIds()` which returns `[...this.trackedStreamIds]`. The mux itself (`StreamMultiplexer` from core) may or may not expose open stream IDs. At S18, confirm:
- Bootstrap's `conn.onclose((openStreamIds) => { ... })` receives the correct open stream IDs.
- The wrapper is sufficient, or if the mux surface needs an accessor, whether it exists.

---

## OUTPUT

After S17 is complete:
- `viewer/dist/` directory (ready for Pages deployment)
- `viewer/public/_headers` with the required header
- `DEPLOY.md` with full instructions (including "don't run this on this machine")
- No new tests (S16 coverage still applies)
- Lint, types, tests all green (no changes expected)
- Branch: `feat/domain-frame` (no new commits unless documentation rewording required)

---

**Ready to proceed when you approve this contract.**
