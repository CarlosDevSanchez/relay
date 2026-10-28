# Relay brand assets

Concept: a brain drawn as circuit traces; two hemispheres (two accounts) sharing one context. Geometry source: the
owner-provided vector trace of the reference logo (`logo-v2.svg`, 13-path potrace output). The canvas rectangle was
dropped, the remaining subpaths are filled with `fill-rule="evenodd"` (ring holes stay open), and the shapes are kept
byte-for-byte in the reference coordinate system (no smoothing). The brain and the RELAY wordmark are separate groups.
Regenerate rasters with `node_modules/.bin/electron scripts/build-icons.mjs` (writes `build/icons/*`,
`build/icon.iconset`, `build/icon.icns`, `build/icon.png`, `favicon.png`, `preview.png`, 1200 px wide (about 0.8 MB): resize after regenerating with `sips --resampleWidth 1200`).

| File | Use |
|---|---|
| `relay-icon.svg` | Primary app icon: squircle tile 824 px centered (Apple grid) with the brain. Used for sizes above 32 px. |
| `relay-mark-small.svg` | Same geometry and layout, brain dilated by a 3-unit stroke (about 1.5x line weight). build-icons uses it for 16 and 32 px only. |
| `relay-icon-light.svg` | Near-white tile, navy brain. |
| `relay-icon-mono.svg` | White on dark, no color. |
| `relay-icon-outline.svg` | Navy tile with teal rim and the same filled brain. |
| `relay-mark.svg` | Brain only, `fill="currentColor"` (sidebar, onboarding header). |
| `relay-logo.svg` | Brain + RELAY wordmark with the reference spacing, teal on transparent (use on dark). |
| `favicon.png` | 64 px render of `relay-icon.svg`. `preview.png` is the contact sheet. |
| `archive/` | Previous card-and-arrows design, history only. |

Palette (sampled as medians from the reference PNG): teal `#69C4CF` (strokes, wordmark), navy `#1A262C` (background,
tile mid-tone); tile gradient `#1F2E35` (top) to `#151F24` (bottom); light variant tile `#FFFFFF` to `#EDF1F3` with
navy `#1A262C` strokes; mono is `#FFFFFF` on `#1E2027` to `#0D0E12`.

Minimum sizes: app icon 16 px (use the small mark; only the silhouette reads at 16, the brain reads from 32);
mark 24 px; logo 96 px wide.

Trademark rule: do not use or imitate Anthropic/Claude or OpenAI/Codex marks (no radiating starburst/asterisk, no cloud shapes).
