# maps.colinkline.com

Wall map PDF generator for real estate agents. Pan, zoom, optionally draw a circle or rectangle, pick a page size (8.5×11, 11×17, or 16×20), download a 300 DPI print-ready PDF.

KLINEKRAFT // CARTO — v1.0

---

## How it works

- **Frontend** (`index.html`) — single-file HTML + Mapbox GL JS interactive map. The orange page frame shows exactly what will print at the selected size.
- **`/api/map-token`** — returns the Mapbox token to the browser. The token itself is restricted by URL referer in the Mapbox dashboard, so even if exposed it can only be used on `maps.colinkline.com`.
- **`/api/generate-pdf`** — receives bounds and selection from the browser, calculates how many tiles are needed at 300 DPI, fetches them in parallel from Mapbox Static Images API, embeds them into a PDF using `pdf-lib`, and streams the PDF back.

---

## Setup on Vercel

1. Create new Vercel project, import this repo.
2. Add env var:
   - `MAPBOX_TOKEN` = your Mapbox public token (`pk....`)
3. In the Mapbox dashboard, add a URL restriction to the token:
   - Allowed URL: `https://maps.colinkline.com/*`
4. Deploy.
5. In Cloudflare DNS, add CNAME `maps` → `cname.vercel-dns.com` (DNS-only, grey cloud).
6. In Vercel project domains, add `maps.colinkline.com`.

---

## Tile count per PDF

At 300 DPI and a max single-tile size of 1280×1280 logical (2560×2560 with `@2x`):

| Page | Pixels | Tiles |
|------|--------|-------|
| 8.5 × 11 | 2550 × 3300 | 2 (1×2) |
| 11 × 17  | 3300 × 5100 | 4 (1×2 or 2×2) |
| 16 × 20  | 4800 × 6000 | 6 (2×3) |

Mapbox free tier is 50,000 Static Images requests/month. Heavy use is fine.

---

## Known limits / future work

- **No labels rotation** — at extreme zooms or skewed selections, label placement is whatever Mapbox decides at the bbox you request.
- **Linear lat/lng projection in the PDF overlay** — the circle/rect drawn on the PDF uses simple linear interpolation rather than Web Mercator inverse. Visually identical at city/regional scales; would diverge at full-state scale (which isn't a typical use case for a wall map).
- **No print preview of selection** — the selection drawn on the interactive map is also drawn on the PDF, but there's no way to fine-tune its position before export. Could add later.
- **Style is locked to Mapbox Light** — to swap, change `MAPBOX_STYLE` in `/api/generate-pdf.js` and the `style` URL in `index.html`. To customize labels/roads for wall-map readability, fork Light in Mapbox Studio and use the custom style ID.

---

## Local sanity check

You can't fully run this locally without `vercel dev` and the env var set, but:

```
npm install
vercel dev
```

Then open `http://localhost:3000`.
