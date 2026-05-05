# maps.colinkline.com

Wall map PDF generator. Pan, zoom, optionally draw a circle or rectangle, pick a page size (8.5×11, 11×17, or 16×20), pick a map style, tweak labels and roads, download a 300 DPI print-ready PDF.

KLINEKRAFT // THE WALL MAP CO. — v1.2

---

## What's new in v1.2

**Critical fix:** PDF generation no longer crashes with `FUNCTION_INVOCATION_FAILED`. v1.0 and v1.1 used the wrong color-object shape for `pdf-lib`; v1.2 uses the correct `rgb()` helper.

**Filson skeuomorphic redesign:** tin cloth waxed canvas green, bridle leather, tarnished brass, cream paper info panel, embossed type. Bree Serif headers + Inter body + JetBrains Mono technical readouts.

**Tier 1 layer features:**
- **Label density** — All / Major / None (Major drops town and neighborhood labels but keeps cities and states)
- **Road weight** — Subtle / Default / Bold (multiplies all road `line-width` expressions)
- **Hide POIs** — single brass toggle to hide all points-of-interest layers
- **Highlight color** — six-swatch picker (brass, orange, red, blue, green, ink). Affects both the live preview and the printed PDF overlay.

All layer prefs persist when you change map styles. The road-weight scaler is style-aware — it preserves Mapbox's zoom-dependent `line-width` interpolation expressions instead of flattening them.

---

## How it works

- **Frontend** (`index.html`) — single-file HTML + Mapbox GL JS interactive map. The brass frame shows what will print.
- **`/api/map-token`** — returns the Mapbox token. Restricted by URL referer in the Mapbox dashboard.
- **`/api/generate-pdf`** — receives bounds + style + accent color from the browser, validates style against a whitelist, fetches Static Images API tiles in parallel at 300 DPI, embeds them into a PDF with `pdf-lib`. Handles both PNG (vector) and JPEG (satellite) tiles. Selection overlay drawn in user-picked accent color.

---

## Setup on Vercel

1. Add env var: `MAPBOX_TOKEN` = your Mapbox public token (`pk....`)
2. In Mapbox dashboard, set URL restriction on the token to `https://maps.colinkline.com`
3. Deploy
4. In Cloudflare DNS: CNAME `maps` → `cname.vercel-dns.com` (DNS-only, grey cloud)
5. Add `maps.colinkline.com` in Vercel project domains

---

## Tile counts per PDF

| Page    | Pixels       | Tiles |
|---------|--------------|-------|
| 8.5×11  | 2550 × 3300  | 2 (1×2) |
| 11×17   | 3300 × 5100  | 4 (1×2 or 2×2) |
| 16×20   | 4800 × 6000  | 6 (2×3) |

Mapbox free tier is 50,000 Static Images requests/month.

---

## Note on layer prefs and the PDF

The label density, road weight, and POI toggles affect the **live preview** map only. The PDF tile requests use Mapbox's standard styles as-is — Mapbox's Static Images API doesn't accept layer-visibility or width-scaling parameters. To bake these toggles into the printed PDF, the next step is to fork these styles in Mapbox Studio with the prefs pre-applied and add them as new style IDs. For most agents, the live-preview behavior is what they want — they can match the PDF output by picking the equivalent "default" settings before exporting.

The accent color *is* threaded through to the PDF — only the toggles are preview-only.

---

## Future polish ideas

- Fork Light style in Mapbox Studio for wall-readable label sizes (1.3-1.5×).
- "Save preset" — bookmark center+zoom+style+toggles per area.
- Multi-page output — print huge maps tiled across letter pages with crop marks.
- Custom area highlighter (irregular polygon, not just circle/rect).
