// /api/generate-pdf.js — v2.0
//
// Wall map PDF generator. Takes a Mapbox center+zoom that matches what
// the user sees on screen, fetches slippy XYZ tiles at zoom+1 (for ~4x
// better print resolution), and stitches them onto a PDF page sized to
// the user's chosen page dimensions.
//
// Why slippy XYZ instead of /static/{lon},{lat},{zoom}/WxH?
// The /static/ endpoint has @2x interaction quirks that don't reliably
// give you the bounded geographic area you specify in WxH. Slippy XYZ
// tiles have rigorously defined geographic coverage:
//   tile (x,y) at zoom z covers exactly 1/(2^z) of the world width.
// This is the same tile pyramid mapbox-gl-js uses for the live preview,
// so the PDF output exactly matches the on-screen map.

import { PDFDocument } from 'pdf-lib';

// Vercel Node.js runtime gives us ~1 GB memory and a 60s timeout, which
// is enough for ~150 tiles at zoom+1 of a poster.
export const maxDuration = 60;

// ============================================================
// STYLE REGISTRY (4 styles, all standard Mapbox)
// ============================================================
const STYLE_REGISTRY = {
  'light':     { mapboxStylePath: 'mapbox/light-v11',             isJpeg: false },
  'dark':      { mapboxStylePath: 'mapbox/dark-v11',              isJpeg: false },
  'streets':   { mapboxStylePath: 'mapbox/streets-v12',           isJpeg: false },
  'satellite': { mapboxStylePath: 'mapbox/satellite-streets-v12', isJpeg: true  },
};

function resolveStyle(styleId) {
  return STYLE_REGISTRY[styleId] || STYLE_REGISTRY['light'];
}

// Vercel Node.js runtime entry point
export default { fetch: handler };

async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const mapboxToken = process.env.MAPBOX_TOKEN;
  if (!mapboxToken) {
    return new Response('MAPBOX_TOKEN not configured', { status: 500 });
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response('Invalid JSON', { status: 400 }); }

  const { center, zoom, pageWidthIn, pageHeightIn, styleId } = body;

  if (!center || typeof zoom !== 'number' || !pageWidthIn || !pageHeightIn) {
    return new Response('Missing required fields', { status: 400 });
  }

  const style = resolveStyle(styleId);

  // ============================================================
  // PICK PRINT ZOOM
  // ============================================================
  // Render at the same zoom the user is looking at, plus 1, for ~4x
  // better print resolution. Clamp to Mapbox's max zoom (22).
  const printZoom = Math.min(22, Math.max(0, Math.round(zoom + 1)));

  // ============================================================
  // FIGURE OUT WHICH TILES COVER THE FRAMED AREA
  // ============================================================
  // The framed area on screen is centered on `center` and has the same
  // aspect ratio as the chosen page (pageWidthIn / pageHeightIn).
  //
  // At zoom z, 256 logical px (one base tile) covers 360/2^z degrees of
  // longitude. We want our PDF page to span the same geographic area
  // as the on-screen frame, so we work out how many logical px wide that
  // span is at the on-screen zoom.

  // The on-screen frame spans the page's aspect-ratio across some screen
  // pixel dimension we don't know precisely from the backend (depends on
  // viewport). Instead, the frontend tells us the bounds of the frame.
  // But to keep this simple, we just say: "the printed map should show
  // exactly what the on-screen map at `zoom` shows, scaled to the page."
  //
  // To do that, we need to compute the geographic bounds of the frame
  // ourselves on the backend. The frame's lng-span at on-screen zoom is
  // determined by how many CSS pixels wide the frame is on screen.
  // Since we don't know that, the cleanest approach is to have the
  // frontend send the bounds, OR have the frontend send a "logical px
  // width" of the frame so we can compute span ourselves.
  //
  // Simpler: the frontend sends `bounds` (sw/ne lng/lat of the frame).
  // We support both, but `bounds` is required.

  const bounds = body.bounds;
  if (!bounds) {
    return new Response('Missing bounds', { status: 400 });
  }

  // ============================================================
  // FETCH TILES & ASSEMBLE PDF
  // ============================================================
  let tileBuffers;
  try {
    tileBuffers = await fetchSlippyTiles({
      bounds, printZoom, style, mapboxToken,
    });
  } catch (e) {
    return new Response(`Tile fetch failed: ${e.message}`, { status: 502 });
  }

  try {
    const pdfDoc = await PDFDocument.create();
    const pageWPts = pageWidthIn * 72;
    const pageHPts = pageHeightIn * 72;
    const page = pdfDoc.addPage([pageWPts, pageHPts]);

    // Geographic dimensions of the framed area
    const lngSpan = bounds.east  - bounds.west;
    const latSpan = bounds.north - bounds.south;

    for (const t of tileBuffers) {
      try {
        const img = t.isJpeg
          ? await pdfDoc.embedJpg(t.buffer)
          : await pdfDoc.embedPng(t.buffer);

        // Linear-map the tile's geo bounds onto PDF points within the
        // frame's geo bounds. Tiles partially outside the frame get
        // clipped automatically by pdf-lib (drawImage outside page area
        // is silently cropped).
        const xLeft   = ((t.tileWest  - bounds.west)  / lngSpan) * pageWPts;
        const xRight  = ((t.tileEast  - bounds.west)  / lngSpan) * pageWPts;
        const yBottom = ((t.tileSouth - bounds.south) / latSpan) * pageHPts;
        const yTop    = ((t.tileNorth - bounds.south) / latSpan) * pageHPts;

        page.drawImage(img, {
          x: xLeft,
          y: yBottom,
          width: xRight - xLeft,
          height: yTop - yBottom,
        });
      } catch (tileErr) {
        console.error(`Skipping bad tile ${t.url}: ${tileErr.message}`);
      }
    }

    const pdfBytes = await pdfDoc.save();
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="wall-map.pdf"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (pdfErr) {
    return new Response(`PDF build failed: ${pdfErr.message}`, { status: 502 });
  }
}

// ============================================================
// SLIPPY XYZ TILE FETCH
// ============================================================
async function fetchSlippyTiles({ bounds, printZoom, style, mapboxToken }) {
  // Compute tile XY range that covers the bounds at printZoom
  const swT = lngLatToTileXY(bounds.west, bounds.south, printZoom);
  const neT = lngLatToTileXY(bounds.east, bounds.north, printZoom);
  const x0 = Math.floor(swT.x);
  const x1 = Math.floor(neT.x);
  const y0 = Math.floor(neT.y);   // north has SMALLER y
  const y1 = Math.floor(swT.y);   // south has LARGER y

  const numTiles = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (numTiles > 400) {
    throw new Error(
      `Too many tiles (${numTiles}) — try a smaller area, smaller page, or zoom in`
    );
  }

  // Build tile spec list
  const tileSpecs = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const bbox = tileXYToBBox(x, y, printZoom);
      // 512px tile @2x = 1024px image, the max-quality path
      const url = `https://api.mapbox.com/styles/v1/${style.mapboxStylePath}/tiles/512/${printZoom}/${x}/${y}@2x?access_token=${mapboxToken}`;
      tileSpecs.push({
        url,
        isJpeg: style.isJpeg,
        tileWest:  bbox.west,
        tileEast:  bbox.east,
        tileNorth: bbox.north,
        tileSouth: bbox.south,
      });
    }
  }

  return await fetchAllBatched(tileSpecs, 16);
}

// ============================================================
// FETCH HELPERS
// ============================================================
// Fetch in parallel batches of N to avoid socket exhaustion / rate limits
// while still being fast (tiles are independent, fully parallelizable).
async function fetchAllBatched(specs, batchSize) {
  const results = [];
  for (let i = 0; i < specs.length; i += batchSize) {
    const batch = specs.slice(i, i + batchSize);
    const out = await Promise.all(batch.map(fetchOne));
    results.push(...out);
  }
  return results;
}

async function fetchOne(spec) {
  const res = await fetch(spec.url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.startsWith('image/')) {
    const text = await res.text().catch(() => '');
    throw new Error(`Expected image, got ${ct}: ${text.slice(0, 200)}`);
  }
  const buffer = await res.arrayBuffer();

  // Magic-byte sanity check
  const bytes = new Uint8Array(buffer);
  const isPng  = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  if (!isPng && !isJpeg) {
    throw new Error(`Bad image format (bytes: ${[...bytes.slice(0, 4)].map(b => b.toString(16)).join(' ')})`);
  }
  return { ...spec, buffer };
}

// ============================================================
// WEB MERCATOR (slippy) MATH
// ============================================================
function lngLatToTileXY(lng, lat, z) {
  const n = Math.pow(2, z);
  const x = ((lng + 180) / 360) * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

function tileXYToBBox(x, y, z) {
  const n = Math.pow(2, z);
  const west  = (x       / n) * 360 - 180;
  const east  = ((x + 1) / n) * 360 - 180;
  const north = mercTileToLat(y,     n);
  const south = mercTileToLat(y + 1, n);
  return { west, east, north, south };
}

function mercTileToLat(y, n) {
  const rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  return rad * 180 / Math.PI;
}
