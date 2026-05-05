# maps.colinkline.com

Wall map PDF generator. Pan, zoom, optionally draw a circle or rectangle, pick a page size, tweak labels and roads, download a 300 DPI print-ready PDF.

KLINEKRAFT // CARTO — v1.5

---

## What's new in v1.5

Two big additions to the style picker:

**Tier B — KLINEKRAFT Monochrome** (Mapbox Studio forks). Four slots reserved for your own published Studio styles: Sage, CB Blue, Sepia, Slate. Until you wire each one up, its pill is dimmed and clicking falls back to Light. Wiring takes about 60 seconds per style — see "Wiring up Klinekraft Mono" below.

**Tier C — Artistic** (Stadia Maps + Stamen). Seven beautiful raster styles served from Stadia Maps' CDN: Watercolor, Toner, Toner Lite, Terrain, Stadia Outdoors, Alidade Smooth, Alidade Smooth Dark. These render at full 300 DPI in the PDF via slippy XYZ tile stitching — no canvas compositing, just pdf-lib placing each tile at its exact lat/lng position on the page.

The style picker is now organized into three categories: Standard, KLINEKRAFT Mono (hidden if all four slots are unwired), and Artistic (hidden if no Stadia API key is set). Layer prefs (label density, road weight, hide POIs, etc.) only apply to Mapbox vector styles, so they automatically dim and an explanatory notice appears when you pick a raster style like Watercolor or Toner.

---

## Architecture

- **Frontend** (`index.html`) — single-file HTML with Mapbox GL JS. Both KLINEKRAFT logo variants are embedded as base64 data URLs.
- **`/api/map-token`** — returns the Mapbox token for the live preview map.
- **`/api/stadia-key`** — returns the Stadia Maps API key (if configured) for the live preview. If absent, the Artistic category is hidden in the UI.
- **`/api/generate-pdf`** — central PDF builder. Routes to one of three providers based on style ID:
  - `mapbox`: standard Mapbox styles, uses the Static Images API (bbox-based fetches at up to 1280×1280 logical px @2x).
  - `mapbox-custom`: same Static Images API, but with a user-defined Studio style path. Falls back to `light-v11` if path is null.
  - `stadia`: Stadia Maps slippy XYZ tiles. Picks the smallest zoom level that meets 300 DPI for the requested print size, fetches every tile that intersects the bbox, and embeds each one at its exact lat/lng position via Web Mercator math. Up to 600 tiles per request, fetched in parallel batches of 16.

---

## Setup on Vercel

1. **Mapbox token** — get a public token (`pk....`) from Mapbox dashboard
   - In Mapbox: restrict the token's allowed URL to `https://maps.colinkline.com`
   - Vercel env var: `MAPBOX_TOKEN`

2. **Stadia API key** — if you want the Artistic styles
   - Sign up at https://client.stadiamaps.com/ (free tier OK for personal/dev use; see "Commercial use" below for production)
   - Generate an API key in your dashboard
   - Add `maps.colinkline.com` to your Authentication Configuration → Domains list (this is the secondary auth layer)
   - Vercel env var: `STADIA_API_KEY`

3. **Deploy** — push to GitHub, Vercel auto-builds.

4. **Cloudflare DNS** — CNAME `maps` → `cname.vercel-dns.com`, set to DNS-only (grey cloud)

5. **Vercel domains** — add `maps.colinkline.com` to the project domains

---

## Wiring up KLINEKRAFT Mono (Tier B)

Each Mono pill needs a published Mapbox Studio style. Quickest path:

1. Open Mapbox Studio (studio.mapbox.com), duplicate **Light** (or Streets — whatever feels right as a starting point)
2. In the editor, change the primary color components (water, roads, land) to your accent color. For Sage Mono use `#6b8a5f`. For CB Blue Mono use `#012169`. Etc.
3. Publish, copy the Style URL (looks like `mapbox://styles/colinkline/abc123def456`)
4. Wire it in **two places** (frontend + backend):

   In `index.html` (around line 1180), find `STYLE_REGISTRY`:
   ```js
   'kk-sage-mono': { provider: 'mapbox-custom', mapboxStylePath: null },
   ```
   Replace `null` with the part after `mapbox://styles/`, e.g. `'colinkline/abc123def456'`.

   In `api/generate-pdf.js`, find the matching entry and make the same change:
   ```js
   'kk-sage-mono': {
     provider: 'mapbox-custom',
     mapboxStylePath: 'colinkline/abc123def456',
     isJpeg: false,
   },
   ```

5. Push to GitHub, Vercel auto-redeploys, the pill becomes enabled.

You don't have to wire all four — leave any unused slots as `null` and they'll stay dimmed. If all four are unwired, the entire Mono category is hidden.

---

## Adding more Stadia styles

Stadia ships more styles than the seven we wired by default. To add another, drop entries in both `STYLE_REGISTRY` definitions:

In `index.html`:
```js
'osm-bright': { provider: 'stadia', stadiaStyle: 'osm_bright', ext: 'png', maxZoom: 20 },
```

In `api/generate-pdf.js`:
```js
'osm-bright': {
  provider: 'stadia',
  stadiaStyle: 'osm_bright',
  isJpeg: false,
  maxZoom: 20,
},
```

And add a pill button in the Artistic row.

Style IDs available at https://docs.stadiamaps.com/themes/.

---

## Commercial use note (Stadia)

Stadia's free tier is for development, evaluation, and non-commercial use only. A real estate brokerage tool counts as commercial under their terms. The free tier is fine for testing, personal use, and showing the tool to colleagues internally — but if you roll this out to CB Select agents at scale, you'll want their Standard plan (~$20/month for 200K credits).

Mapbox is similar but more generous — 50K monthly Static Image API requests on their free tier, which is plenty for personal use and small team usage. Each PDF generation = ~2 to 6 Static Image requests, so you have a lot of headroom.

---

## Tile counts and timing (Stadia)

Slippy tile fetches scale with print size and bbox span. Rough numbers for typical Tulsa-metro-sized maps (~18 mi span):

| Page size | Tiles | Approx. time @ 16-parallel |
|-----------|-------|----------------------------|
| 8.5×11    | ~150  | ~2 s                       |
| 11×17     | ~150  | ~2 s                       |
| 16×20     | ~550  | ~7 s                       |

Bigger areas need fewer tiles per inch, smaller areas need more. The 600-tile cap is enforced server-side; if you hit it, try a smaller area or page size. Watercolor is hard-capped at zoom 16 (Stadia limit), so you'll always be safely within the cap with that style.

---

## File layout

```
/
├── index.html              ~190KB, includes both KLINEKRAFT logos as base64
├── api/
│   ├── map-token.js        returns Mapbox token to browser
│   ├── stadia-key.js       returns Stadia API key to browser (or null)
│   └── generate-pdf.js     PDF builder, routes to mapbox / mapbox-custom / stadia
├── package.json            pdf-lib ^1.17.1
├── vercel.json             cleanUrls, no trailing slash
└── README.md
```
