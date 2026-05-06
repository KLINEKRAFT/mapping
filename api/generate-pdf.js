// /api/generate-pdf.js — v1.8.0
//   * Single-image rendering replaces the multi-tile stitch. Stitched tiles
//     produced two visible bugs: (a) labels at tile seams clipped/duplicated
//     because Mapbox static images anchor labels per-image, and (b) when
//     targeting 300 DPI the per-tile zoom level pushed every label down to
//     ~6 pt on the printed page (Mapbox renders labels in logical pixels;
//     1 logical px = 1/150 inch at 300 DPI / @2x).
//   * The new fetch sends a single Mapbox static image sized to fit within
//     the 1280-logical-px limit while matching page aspect, then scales it
//     up to fill the PDF page. Effective DPI varies by page size
//     (~232 letter / ~150 tabloid / ~128 poster) but labels render at a
//     readable physical size and there are no seams.

import { PDFDocument, rgb } from 'pdf-lib';

// Run on Node.js runtime. Node.js gives us ~1 GB memory and a 60s
// timeout, which is needed for 16x20 satellite maps where pdf-lib
// has to embed multi-MB JPEG buffers without OOM.
export const maxDuration = 60;

// ============================================================
// STYLE REGISTRY
// ============================================================
//   provider: 'mapbox'         -> Mapbox Static Images API (bbox-based)
//   provider: 'mapbox-custom'  -> Same API, but with a user-defined Studio URL
//
// To add a new Mapbox Studio fork:
//   1. Duplicate one of the standard styles in Mapbox Studio (or upload JSON)
//   2. Edit colors / typography / etc, save and publish
//   3. Copy the style URL (looks like mapbox://styles/USERNAME/STYLE_ID)
//   4. Add an entry below with provider: 'mapbox-custom' and
//      mapboxStylePath: 'USERNAME/STYLE_ID'

const STYLE_REGISTRY = {
  // -- Standard Mapbox styles ----------------------------------------------
  'light-v11': {
    provider: 'mapbox',
    mapboxStylePath: 'mapbox/light-v11',
    isJpeg: false,
  },
  'streets-v12': {
    provider: 'mapbox',
    mapboxStylePath: 'mapbox/streets-v12',
    isJpeg: false,
  },
  'outdoors-v12': {
    provider: 'mapbox',
    mapboxStylePath: 'mapbox/outdoors-v12',
    isJpeg: false,
  },
  'satellite-v9': {
    provider: 'mapbox',
    mapboxStylePath: 'mapbox/satellite-v9',
    isJpeg: true,
  },
  'satellite-streets-v12': {
    provider: 'mapbox',
    mapboxStylePath: 'mapbox/satellite-streets-v12',
    isJpeg: false,
  },

  // -- KLINEKRAFT (custom Studio JSON uploads) -----------------------------
  'kk-carto': {
    provider: 'mapbox-custom',
    mapboxStylePath: 'klinekraft/cmou53fe2001j01s448kk5v7j',
    isJpeg: false,
  },
  'kk-carto-light': {
    provider: 'mapbox-custom',
    mapboxStylePath: 'klinekraft/cmouag1xz001e01qrdv9v49np',
    isJpeg: false,
  },
  'kk-carto-bright': {
    provider: 'mapbox-custom',
    mapboxStylePath: 'klinekraft/cmouacmlr001d01qr7env8jrr',
    isJpeg: false,
  },
  'kk-carto-heritage': {
    provider: 'mapbox-custom',
    mapboxStylePath: 'klinekraft/cmouae103006j01rs9v0277d0',
    isJpeg: false,
  },
  'kk-carto-mist': {
    provider: 'mapbox-custom',
    mapboxStylePath: 'klinekraft/cmouahywv000t01qn7xl76op6',
    isJpeg: false,
  },
  'kk-carto-midnight': {
    provider: 'mapbox-custom',
    mapboxStylePath: 'klinekraft/cmouagu5i001a01rwfx147zyq',
    isJpeg: false,
  },
  'kk-cb-mono': {
    provider: 'mapbox-custom',
    mapboxStylePath: 'klinekraft/cmot54v7k00b401saabawemj2',
    isJpeg: false,
  },
};

// Resolve a style ID; if the requested style isn't valid or the custom
// path hasn't been wired yet, fall back to light-v11.
function resolveStyle(styleId) {
  const entry = STYLE_REGISTRY[styleId];
  if (!entry) return { id: 'light-v11', ...STYLE_REGISTRY['light-v11'] };
  if (entry.provider === 'mapbox-custom' && !entry.mapboxStylePath) {
    return { id: 'light-v11', ...STYLE_REGISTRY['light-v11'] };
  }
  return { id: styleId, ...entry };
}

// ============================================================
// CONSTANTS
// ============================================================
const MAPBOX_MAX_LOGICAL = 1280;  // Mapbox static-images per-side limit

// ============================================================
// HANDLER
// ============================================================
async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const mapboxToken = process.env.MAPBOX_TOKEN;

  if (!mapboxToken) {
    return new Response('MAPBOX_TOKEN not configured', { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const {
    bounds,
    pageWidthIn,
    pageHeightIn,
    selection,
    styleId,
    accentColor,
  } = body;

  if (!bounds || !pageWidthIn || !pageHeightIn) {
    return new Response('Missing required fields', { status: 400 });
  }
  if (typeof bounds.west !== 'number' || typeof bounds.east !== 'number' ||
      typeof bounds.north !== 'number' || typeof bounds.south !== 'number') {
    return new Response('Invalid bounds', { status: 400 });
  }

  const style = resolveStyle(styleId);
  if (style.provider !== 'mapbox' && style.provider !== 'mapbox-custom') {
    return new Response(`Unknown provider: ${style.provider}`, { status: 400 });
  }
  const accent = parseHexToRgb(accentColor) || rgb(1.0, 0.357, 0.016);

  // Pick a logical-pixel size that matches the page aspect and fits in
  // Mapbox's 1280-per-side static-image budget. The longer side gets 1280;
  // the shorter side scales down. The PDF page then upscales the image to
  // fill the print area.
  const pageAspect = pageWidthIn / pageHeightIn;
  let logicalW, logicalH;
  if (pageAspect >= 1) {
    logicalW = MAPBOX_MAX_LOGICAL;
    logicalH = Math.max(1, Math.round(logicalW / pageAspect));
  } else {
    logicalH = MAPBOX_MAX_LOGICAL;
    logicalW = Math.max(1, Math.round(logicalH * pageAspect));
  }

  // Center + zoom from the framed bounds. The user framed an exact lng span
  // in the live preview; we pick the zoom that packs that span into logicalW.
  const center = {
    lng: (bounds.west + bounds.east) / 2,
    lat: (bounds.north + bounds.south) / 2,
  };
  const lngSpan = Math.abs(bounds.east - bounds.west);
  if (!(lngSpan > 0)) {
    return new Response('Degenerate bounds (zero lng span)', { status: 400 });
  }
  const rawZoom = Math.log2((logicalW * 360) / (256 * lngSpan));
  const zoom = Math.max(0, Math.min(22, rawZoom));

  // Re-derive the bounds the static image will actually cover. The framed
  // bounds may have a slightly different lat span than what fits the page
  // aspect at this zoom (Mercator distortion at non-zero latitude); the
  // selection overlay needs the rendered bounds, not the requested ones.
  const renderedBounds = computeBoundsFromCenterZoom(center, zoom, logicalW, logicalH);

  // ============================================================
  // FETCH SINGLE STATIC IMAGE
  // ============================================================
  let imageBuffer;
  let imageIsJpeg;
  try {
    const url =
      `https://api.mapbox.com/styles/v1/${style.mapboxStylePath}/static/` +
      `${center.lng.toFixed(6)},${center.lat.toFixed(6)},${zoom.toFixed(4)},0/` +
      `${logicalW}x${logicalH}@2x` +
      `?access_token=${mapboxToken}&attribution=false&logo=false`;

    const fetched = await fetchImage(url);
    imageBuffer = fetched.buffer;
    imageIsJpeg = fetched.isJpeg;
  } catch (e) {
    return new Response(`Tile fetch failed: ${e.message}`, { status: 502 });
  }

  // ============================================================
  // BUILD PDF
  // ============================================================
  try {
    const pdfDoc = await PDFDocument.create();
    const pageWPts = pageWidthIn * 72;
    const pageHPts = pageHeightIn * 72;
    const page = pdfDoc.addPage([pageWPts, pageHPts]);

    // White background in case the embedded image has transparency.
    page.drawRectangle({
      x: 0, y: 0,
      width: pageWPts,
      height: pageHPts,
      color: rgb(1, 1, 1),
    });

    const img = imageIsJpeg
      ? await pdfDoc.embedJpg(imageBuffer)
      : await pdfDoc.embedPng(imageBuffer);

    page.drawImage(img, {
      x: 0, y: 0,
      width: pageWPts,
      height: pageHPts,
    });

    if (selection) {
      drawSelectionOverlay(page, selection, renderedBounds, pageWPts, pageHPts, accent);
    }

    const pdfBytes = await pdfDoc.save();

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="wall-map.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (pdfErr) {
    return new Response(`PDF build failed: ${pdfErr.message}`, { status: 502 });
  }
}

// ============================================================
// FETCH HELPER
// ============================================================
async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.startsWith('image/')) {
    const text = await res.text().catch(() => '');
    throw new Error(`Expected image but got ${ct}: ${text.slice(0, 200)}`);
  }
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  if (!isPng && !isJpeg) {
    throw new Error(`Buffer is neither PNG nor JPEG (first bytes: ${[...bytes.slice(0,4)].map(b=>b.toString(16)).join(' ')})`);
  }
  return { buffer, isJpeg };
}

// ============================================================
// UTILITY HELPERS
// ============================================================
function parseHexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
}

function lngLatToPagePts(lng, lat, bounds, pageWPts, pageHPts) {
  const x = ((lng - bounds.west)  / (bounds.east  - bounds.west))  * pageWPts;
  const y = ((lat - bounds.south) / (bounds.north - bounds.south)) * pageHPts;
  return { x, y };
}

// Compute the geographic bounds the static image will cover, given the
// center, zoom, and the image's logical-pixel size. Mapbox's static API
// uses Web Mercator and renders at the requested logical size; we mirror
// that math so the selection overlay lines up with the rendered map.
function computeBoundsFromCenterZoom(center, zoom, logicalW, logicalH) {
  const lngPerLogicalPx = 360 / (256 * Math.pow(2, zoom));
  const halfW = logicalW / 2;
  const halfH = logicalH / 2;

  const west = center.lng - halfW * lngPerLogicalPx;
  const east = center.lng + halfW * lngPerLogicalPx;

  // Latitude via Mercator inversion
  const r = center.lat * Math.PI / 180;
  const centerMercY = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 * Math.pow(2, zoom);

  const mercYToLat = (y) => {
    const rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (256 * Math.pow(2, zoom)))));
    return rad * 180 / Math.PI;
  };

  const north = mercYToLat(centerMercY - halfH);  // smaller y → north
  const south = mercYToLat(centerMercY + halfH);  // larger y → south

  return { west, east, north, south };
}

function drawSelectionOverlay(page, selection, bounds, pageWPts, pageHPts, accent) {
  if (selection.type === 'circle') {
    const center = selection.center;
    const radiusMi = selection.radiusMi;
    const steps = 96;
    const radiusKm = radiusMi * 1.609344;
    const earthR = 6371;
    const angDist = radiusKm / earthR;
    const latRad = center[1] * Math.PI / 180;
    const lngRad = center[0] * Math.PI / 180;

    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const brg = (i / steps) * 2 * Math.PI;
      const newLat = Math.asin(
        Math.sin(latRad) * Math.cos(angDist) +
        Math.cos(latRad) * Math.sin(angDist) * Math.cos(brg)
      );
      const newLng = lngRad + Math.atan2(
        Math.sin(brg) * Math.sin(angDist) * Math.cos(latRad),
        Math.cos(angDist) - Math.sin(latRad) * Math.sin(newLat)
      );
      pts.push(lngLatToPagePts(newLng * 180 / Math.PI, newLat * 180 / Math.PI, bounds, pageWPts, pageHPts));
    }

    for (let i = 0; i < pts.length - 1; i++) {
      page.drawLine({
        start: { x: pts[i].x,     y: pts[i].y },
        end:   { x: pts[i + 1].x, y: pts[i + 1].y },
        thickness: 2,
        color: accent,
      });
    }

    const c = lngLatToPagePts(center[0], center[1], bounds, pageWPts, pageHPts);
    page.drawCircle({ x: c.x, y: c.y, size: 4, color: accent });
  } else if (selection.type === 'rect') {
    const sw = lngLatToPagePts(selection.sw[0], selection.sw[1], bounds, pageWPts, pageHPts);
    const ne = lngLatToPagePts(selection.ne[0], selection.ne[1], bounds, pageWPts, pageHPts);
    page.drawRectangle({
      x: sw.x, y: sw.y,
      width: ne.x - sw.x,
      height: ne.y - sw.y,
      borderColor: accent,
      borderWidth: 2,
    });
  }
}

// Vercel Node.js runtime entry point — uses the fetch Web Standard
// signature so we keep using Web standard Request/Response APIs.
export default { fetch: handler };
