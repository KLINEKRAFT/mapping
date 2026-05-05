# maps.colinkline.com

Wall map PDF generator. Pan, zoom, optionally draw a circle or rectangle, pick a page size, tweak labels and roads, download a 300 DPI print-ready PDF.

KLINEKRAFT // CARTO — v1.3

---

## What's new in v1.3

**Sage neumorphic UI** — soft pillow shadows, sage green accents (`#6b8a5f`), Inter throughout, modern + clean. Filson skeuomorphic look retired.

**Light + dark themes** — toggle in the header, preference saved to localStorage. Both themes use the same sage accent so highlights stay consistent.

**Label controls:**
- **Density** — All / Major / None (kept from v1.2)
- **Size slider** — 0.7× to 1.6×, scales `text-size` across all symbol layers while preserving Mapbox's zoom expressions
- **Bold toggle** — swaps label `text-font` to bold variants (DIN Pro Bold, Open Sans Bold, etc. — bundled by Mapbox, no Studio needed)

**Custom-style hook** — the `CUSTOM_STYLES` map in `index.html` is ready for v1.4 Studio-forked styles. Add an entry there and a corresponding pill, and the picker handles both Mapbox built-ins and custom styles transparently.

---

## v1.4 plan — bake controls into the printed PDF

The label size, label bold, road weight, and POI toggles affect the **live preview only**. Mapbox Static Images API doesn't accept layer-visibility or text-size as request parameters, so the printed PDF uses the base style as-is.

To bake these into the print:

1. Open Mapbox Studio, fork each base style (Light, Streets, Outdoors, Satellite Streets)
2. Apply your preferred label size, font weight, road width, and POI visibility
3. Save and copy the new style URLs (e.g. `mapbox://styles/klinekraft/cl...`)
4. In `index.html`, add to the `CUSTOM_STYLES` map:
   ```js
   const CUSTOM_STYLES = {
     'wall-light-v1': { url: 'mapbox://styles/klinekraft/cl...', isRaster: false }
   };
   ```
5. Add a pill in the HTML: `<button class="neu-btn style-pill" data-style="wall-light-v1" data-raster="false">Wall Light</button>`
6. In `api/generate-pdf.js`, add `'wall-light-v1'` to the `ALLOWED_STYLES` set, and update the URL builder to use the custom URL when the style ID matches.

Estimated time: 30-45 minutes in Studio + 10 minutes of code changes.

---

## How it works

- **Frontend** (`index.html`) — single-file HTML + Mapbox GL JS interactive map. Brass-frame removed; accent frame is now sage by default.
- **`/api/map-token`** — returns the Mapbox token. URL-restricted in dashboard.
- **`/api/generate-pdf`** — receives bounds + style + accent color, validates style against whitelist, fetches Static Images API tiles in parallel at 300 DPI, embeds into a PDF with `pdf-lib`. Unchanged from v1.2 (already tested end-to-end).

---

## Setup on Vercel

1. Add env var: `MAPBOX_TOKEN` = your Mapbox public token (`pk....`)
2. Mapbox dashboard: URL restriction `https://maps.colinkline.com`
3. Deploy
4. Cloudflare DNS: CNAME `maps` → `cname.vercel-dns.com` (DNS-only, grey cloud)
5. Vercel project domains: add `maps.colinkline.com`

---

## Tile counts per PDF

| Page    | Pixels       | Tiles |
|---------|--------------|-------|
| 8.5×11  | 2550 × 3300  | 2 (1×2) |
| 11×17   | 3300 × 5100  | 4 (1×2 or 2×2) |
| 16×20   | 4800 × 6000  | 6 (2×3) |

Mapbox free tier is 50,000 Static Images requests/month.
