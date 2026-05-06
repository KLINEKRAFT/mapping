# KLINEKRAFT // CARTO — v2.0

Wall map PDF generator for Coldwell Banker Select agents.

## How it works

1. Pan/zoom the map. The black framed rectangle shows what will print.
2. Pick a style (Light / Dark Blue / Streets / Satellite).
3. Pick a page size (Letter / Tabloid / Poster) and orientation.
4. Click **Generate PDF**.

The exported PDF shows exactly the framed area at the page's aspect ratio.
Print resolution is automatic — the backend renders at the on-screen zoom + 1
which gives roughly 4x more tiles for crisp print output.

## Stack

- Single-file `index.html` with Mapbox GL JS for the live preview
- Vercel serverless function (`api/generate-pdf.js`) on Node.js runtime
- `api/map-token.js` returns the public Mapbox token from env
- `pdf-lib` for stitching tiles into a PDF
- Mapbox Static Tiles API for tile fetching

## Deploy

1. Connect this repo to Vercel.
2. Set `MAPBOX_TOKEN` env var to a public Mapbox access token (`pk.…`)
3. Push to main. Vercel deploys automatically.
4. Add custom domain `maps.colinkline.com` (CNAME, DNS-only).

## Environment

Required:

| Var | Purpose |
| --- | --- |
| `MAPBOX_TOKEN` | Public Mapbox access token (`pk.…`) for tiles + map-gl-js |

## Cost notes

Mapbox Static Tiles API: free up to 200K tile requests/month, then
$0.50 per 1000. At zoom + 1 a Letter page is ~30-60 tiles, a Tabloid
~80 tiles, a Poster ~150 tiles. That's ~1300+ free PDFs per month.

## Styles

| ID | Mapbox style |
| --- | --- |
| `light` | `mapbox/light-v11` |
| `dark` | `mapbox/dark-v11` |
| `streets` | `mapbox/streets-v12` |
| `satellite` | `mapbox/satellite-streets-v12` |

To swap any of these for a custom Studio style later: change the path
in `STYLE_REGISTRY` (`api/generate-pdf.js`) and `STYLE_MAPBOX_PATHS`
(`index.html`). They must match.
