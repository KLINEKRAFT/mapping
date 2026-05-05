# maps.colinkline.com

Wall map PDF generator for real estate agents. Pan, zoom, optionally draw a circle or rectangle, pick a page size (8.5×11, 11×17, or 16×20), pick a map style, download a 300 DPI print-ready PDF.

KLINEKRAFT // CARTO — v1.1

---

## What's new in v1.1

- **Style switcher** — five Mapbox styles in a horizontal pill row:
  - **Light** — clean, minimal, white-ish (best for pin-tracking)
  - **Streets** — colored roads, more landmarks
  - **Outdoors** — terrain shading, parks/trails (good for rural/lake areas)
  - **Satellite** — pure aerial imagery
  - **Sat Streets** — aerial with road overlays and labels
- Selected style persists when you pan, zoom, or change page size
- The circle/rect selection persists across style changes
- Warning shown when picking a satellite style at 16×20 (raster softness)

---

## How it works

- **Frontend** (`index.html`) — single-file HTML + Mapbox GL JS interactive map. The orange page frame shows exactly what will print.
- **`/api/map-token`** — returns the Mapbox token to the browser. Token is restricted by URL referer in the Mapbox dashboard.
- **`/api/generate-pdf`** — receives bounds, selection, and style ID from the browser. Validates style against a whitelist, fetches tiles in parallel from Mapbox Static Images API at 300 DPI, embeds them into a PDF using `pdf-lib`. Handles both PNG (vector styles) and JPEG (satellite) tile formats.

---

## Setup on Vercel

1. Add env var: `MAPBOX_TOKEN` = your Mapbox public token (`pk....`)
2. In Mapbox dashboard, set URL restriction on the token to `https://maps.colinkline.com`
3. Deploy
4. In Cloudflare DNS, CNAME `maps` → `cname.vercel-dns.com` (DNS-only, grey cloud)
5. Add `maps.colinkline.com` in Vercel project domains

---

## Tile count per PDF

| Page    | Pixels       | Tiles |
|---------|--------------|-------|
| 8.5 × 11| 2550 × 3300  | 2 (1×2) |
| 11 × 17 | 3300 × 5100  | 4 (1×2 or 2×2) |
| 16 × 20 | 4800 × 6000  | 6 (2×3) |

Mapbox free tier is 50,000 Static Images requests/month.

---

## Future polish

- Fork Light style in Mapbox Studio for wall-readable label sizes (1.3-1.5× scale, fatter roads). Drop the custom style ID into the `data-style` attribute and `ALLOWED_STYLES` whitelist.
- "Save preset" — let users bookmark a center+zoom+style combo for an area they print frequently.
- Multi-page output — print huge maps as tiled letter pages with crop marks.
