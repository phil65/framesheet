# Sketch: framesheet as an agent tool in contexter

A design sketch, not code in contexter. It shows how contexter's own agent could render
the SVG/HTML it generated (diagrams, mind maps, slides, drawings exported to SVG), look at
the images and fix its output. It follows the pattern contexter already uses for 3D parts
(`src/lib/ai/tools/parts/render-part.ts`: an AI SDK `tool()` whose result has the shape
of an MCP call result, so pictures reach the model as images, converted by
`toModelOutput: ({ output }) => mcpToolModelOutput(output)`).

## The tool

`inspect_animation`: render an SVG/HTML file (or markup) at evenly spaced virtual times
and return a text summary plus images.

### Input

```ts
const inputSchema = z.object({
  path: z.string().optional()
    .describe('A file in the workspace, e.g. "/drawings/flow.svg" or "/slides/intro.html"'),
  markup: z.string().max(512_000).optional()
    .describe("SVG or HTML markup to inspect instead of a file (starts with <)"),
  views: z.array(z.enum(["sheet", "heatmap", "full"])).default(["sheet", "heatmap"])
    .describe("sheet: frames over one cycle; heatmap: what moves at all; full: one frame at full size"),
  frames: z.number().int().min(2).max(16).default(8),
  duration: z.number().positive().max(30).optional()
    .describe("Cycle length in seconds; only for JS-driven animation (otherwise detected)"),
  at: z.number().min(0).optional().describe("Time in seconds of the full frame"),
  size: z.tuple([z.number().int().min(16).max(1920), z.number().int().min(16).max(1080)]).optional(),
}).refine((v) => Boolean(v.path) !== Boolean(v.markup), "Give either path or markup");
```

Exactly one of `path` / `markup`. Files are read through the VFS server-side and passed to
framesheet as a markup string, so the browser never sees a `file://` URL or the server's
filesystem.

### Output (MCP call result)

```ts
{
  content: [
    { type: "text", text: result.summary() },            // findings, duration, loop verdict
    { type: "image", mimeType: "image/png", data: b64(result.images.sheet) },
    { type: "image", mimeType: "image/png", data: b64(result.images.heatmap) },
    // + full.png when views includes "full"
  ],
  // No isError for findings: an ERROR finding is information for the model, not a failed call.
}
```

`summary()` is the same text the Python CLI prints, e.g.:

```text
framesheet: <snippet> (svg, 400x200 @1x)
duration: 3s detected: loop period 2s; + 1s positive begin/delay before the first loop (1 animation(s): smil) [looping]
frames: 8 at t=0.00..2.98s; max change 0.6% at t=2.98s
loop: NOT seamless (last frame -> first frame changes 0.37% of pixels, one normal step changes 0.00%)
animated elements: circle#dot
findings: 0 error(s), 3 warning(s), 0 info
  WARN  [static] positive-begin: <animateMotion begin='1s'> uses a positive delay; ...
  WARN  [render] parked-at-origin: circle#dot sits at the SVG origin (0,0) at t=0.00s, 0.43s, 0.85s; ...
images: ...
```

Drop the trailing `images:` lines (they are file names without `out`) or replace them
with "image 1: contact sheet, image 2: motion heatmap". Keep `report` (the JSON) out of
the model context by default; it is large and the summary carries its conclusions. If a
follow-up needs numbers (boxes per frame, changed-pixel ratios), a `details: true` input
can append `JSON.stringify(result.report.findings)` or `report.elements`.

The sheet is at most 1568 px wide (what vision models take without downscaling); the
heatmap at most 1304 px. Two images per call is a reasonable default budget.

### Implementation sketch

```ts
// src/lib/ai/tools/animation/inspect-animation.ts
import "server-only";
import { type Tool, tool } from "ai";
import { inspect } from "framesheet";
import { type McpCallResult, mcpToolModelOutput } from "@/lib/ai/mcp/tool-result";
import type { Vfs } from "@/lib/vfs";
import { VfsError } from "@/lib/vfs";
import { withBrowser } from "./browser-pool";

const TIMEOUT_MS = 20_000;

export function createInspectAnimationTool(vfs: Vfs, deps = { inspect, withBrowser }): Tool {
  return tool({
    description:
      "Render an animated SVG or HTML file and look at it over time: a contact sheet of " +
      "frames over one cycle, a heatmap of everything that moves, and checks (elements " +
      "parked at (0,0), outside the canvas, overflowing text, loops that jump, broken " +
      "references). Call it after every change to an animated SVG/HTML file.",
    inputSchema,
    execute: async (input): Promise<McpCallResult> => {
      let markup = input.markup;
      if (input.path) {
        try {
          markup = (await vfs.readWhole(input.path)).content;
        } catch (error) {
          if (error instanceof VfsError) return { isError: true, content: [{ type: "text", text: error.message }] };
          throw error;
        }
      }
      if (!markup?.trimStart().startsWith("<")) {
        return { isError: true, content: [{ type: "text", text: "Not SVG/HTML markup" }] };
      }
      const result = await deps.withBrowser((browser) =>
        deps.inspect(markup!, {
          browser,
          blockNetwork: true,      // agent output must not fetch anything
          frames: input.frames,
          heatFrames: 12,          // ~2 s per call instead of ~5-8 s
          duration: input.duration,
          at: input.at,
          size: input.size,
          timeout: TIMEOUT_MS,
        }), TIMEOUT_MS + 5_000);
      const images = { sheet: result.images.sheet, heatmap: result.images.heatmap, full: result.images.full };
      return {
        content: [
          { type: "text", text: result.summary().split("\nimages:")[0] },
          ...input.views.map((view) => ({
            type: "image" as const,
            mimeType: "image/png",
            data: images[view].toString("base64"),
          })),
        ],
      };
    },
    toModelOutput: ({ output }) => mcpToolModelOutput(output),
  });
}
```

Register it where `render_part` is registered (`src/lib/ai/chat/engines/openrouter.ts`,
and in `src/lib/ai/editor/run-editor-turn.ts` for SVG/HTML file types), and add one line
to the file guide (`src/lib/ai/editor/file-guides.ts`): "After every change to an animated
SVG/HTML file call inspect_animation and fix every ERROR and WARN; check that the first
and last tile of the sheet join up for a loop and that nothing unexpected is coloured in
the heatmap."

### Browser pool, limits, timeouts

```ts
// browser-pool.ts: one Chromium per server process, launched lazily, at most N pages.
import { type Browser, chromium } from "playwright-core";
import { LAUNCH_ARGS } from "framesheet";

let browser: Promise<Browser> | null = null;
let active = 0;
const MAX_ACTIVE = 2;
const queue: (() => void)[] = [];

async function getBrowser(): Promise<Browser> {
  browser ??= (process.env.FRAMESHEET_BROWSER_WS
    ? chromium.connect(process.env.FRAMESHEET_BROWSER_WS)      // sidecar (see below)
    : chromium.launch({ args: LAUNCH_ARGS })
  ).then((b) => {
    b.on("disconnected", () => { browser = null; });
    return b;
  });
  return browser;
}

export async function withBrowser<T>(fn: (b: Browser) => Promise<T>, timeoutMs: number): Promise<T> {
  if (active >= MAX_ACTIVE) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    const b = await getBrowser();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("inspect_animation timed out")), timeoutMs);
    });
    return await Promise.race([fn(b), timeout]).finally(() => clearTimeout(timer));
  } finally {
    active--;
    queue.shift()?.();
  }
}
```

- Every `inspect()` call uses its own browser context (closed afterwards), so calls do not
  share cookies, storage, routes or clocks.
- `timeout` bounds navigation and page scripts; the outer race bounds the whole call (an
  infinite loop in agent JS blocks the page's main thread; on timeout close the browser
  (`browser.close()`) so the next call starts a fresh one).
- Cap the markup size (512 KB above), `frames` (16) and `duration` (30 s): the work is
  linear in frames, and the heatmap pass adds `heatFrames` screenshots.
- Charge it like other tools if needed (one call is ~2 s of one Chromium page).

### Sandboxing

- Agent HTML may run scripts: that is the point for JS-driven animation, and it runs only
  inside Chromium. `blockNetwork: true` aborts every HTTP(S) request except the input itself
  (images, fonts, fetch/XHR) and closes every WebSocket: no exfiltration, no SSRF against
  internal services. (DNS prefetch hints are not requests; the sidecar's network policy
  covers those.) Markup is served from a virtual origin (`http://framesheet.invalid/`) through
  `page.route`, never from disk.
- Playwright launches Chromium with its sandbox **off** by default
  (`chromiumSandbox: false`). For untrusted content either enable it
  (`chromium.launch({ chromiumSandbox: true, args: LAUNCH_ARGS })`, which needs
  unprivileged user namespaces in the container) or, simpler and stronger, run the browser
  in its own container without network egress and without access to the app's secrets
  (the sidecar below).
- Do not pass user-controlled `out` paths; the tool never writes files.

## Chromium in the deployment

contexter's runtime image is `node:24-alpine`. Playwright's Chromium builds need glibc and
are not supported on Alpine (musl), so the server cannot simply `launch()` there. Two
options:

1. **Sidecar browser (recommended).** Keep the app image as it is and add a service
   running Playwright's browser server with exactly the app's `playwright-core` version:

   ```yaml
   # docker/compose.yml
   framesheet-browser:
     image: mcr.microsoft.com/playwright:v1.65.1-noble
     command: ["npx", "-y", "playwright@1.65.1", "run-server", "--port", "3001", "--host", "0.0.0.0"]
     init: true
     ipc: host            # Chromium needs more shared memory than Docker's 64 MB default
     networks: [internal] # reachable from the app only; no egress needed with blockNetwork
   ```

   and set `FRAMESHEET_BROWSER_WS=ws://framesheet-browser:3001/` for the app. The pool
   above then uses `chromium.connect()`; framesheet runs its pages in that browser
   (pass `LAUNCH_ARGS` via the server's launch options, e.g. a `--` wrapper or a small
   `launchServer({ args: LAUNCH_ARGS })` script, for byte-stable frames). The client and
   server versions must match (major.minor).

2. **Debian-based runner.** Switch the runner stage to `node:24-bookworm-slim` and add
   `npx playwright install --with-deps chromium-headless-shell` (~+250 MB). Simpler, but
   the browser then shares the app's container, network and secrets.

Either way:

- Next.js standalone output: list `framesheet` and `playwright-core` in
  `serverExternalPackages` (next.config) so they are required at runtime from
  `node_modules` instead of being bundled (playwright-core resolves files dynamically),
  and make sure `.next/standalone` ships them (output file tracing, or copy them).
- Fonts: the images contain whatever fonts the browser machine has. Install the fonts the
  app's SVG/HTML use (or embed them as data: URLs) so the agent sees what users see.
- Health: launch failures surface as `BrowserNotInstalledError` (`INSTALL_HINT`); map them
  to a tool error with a clear message rather than retrying.

## Tests in contexter

- Unit: like `render-part.test.ts`, inject `deps.inspect` and assert the MCP result shape
  (text first, then one image per view; VFS errors become `isError`).
- Integration (optional, needs Chromium): run the real tool on a tiny SVG with a
  positive `animateMotion begin` and assert the summary contains `parked-at-origin`.
- e2e: visual regression of contexter's own animated components with `framesheet/test`
  (`expectAnimation(page.locator(...), "mindmap-open", { frames: 8, trigger })`), see the
  npm package's README.

## Open questions

- Which file types get the tool by default (SVG drawings and diagrams certainly; HTML
  slides; Excalidraw/mind maps only once exported to SVG/HTML server-side)?
- Is one shared sidecar browser enough, or one per worker/region?
- Should `inspect_animation` also accept a rendered app URL for the user's own pages
  (`inspect(url)`)? With `blockNetwork` that only works for self-contained pages, and
  without it it is an SSRF surface: keep it out of the first version.
