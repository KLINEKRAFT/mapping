// /api/generate-pdf.js — v1.7.1
//   * 7 KK Carto Studio styles wired (Light / Bright / Heritage / Mist /
//     Midnight / KK Carto / CB Blue Mono)
//   * Stadia provider removed entirely
//   * Mapbox static images now use center+zoom (was bbox) — fixes
//     the overshoot-bounds bug and the tiny-labels bug. Backend
//     also recomputes bounds from center+zoom for selection overlay.

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
const MAPBOX_MAX_TILE_LOGICAL = 1280;  // Mapbox limit
const TARGET_DPI = 300;

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
    center,
    zoom,
    pageWidthIn,
    pageHeightIn,
    selection,
    styleId,
    accentColor,
  } = body;

  if (!bounds || !pageWidthIn || !pageHeightIn) {
    return new Response('Missing required fields', { status: 400 });
  }
  if (!center || typeof zoom !== 'number') {
    return new Response('Missing center or zoom', { status: 400 });
  }

  const style = resolveStyle(styleId);
  const accent = parseHexToRgb(accentColor) || rgb(1.0, 0.357, 0.016);

  const outW = Math.round(pageWidthIn * TARGET_DPI);
  const outH = Math.round(pageHeightIn * TARGET_DPI);

  // Compute the EXACT geographic bounds that will be rendered, given center
  // and zoom. This must use the same Web Mercator math the tile fetcher uses
  // so the selection overlay lines up perfectly with the rendered map.
  const renderedBounds = computeBoundsFromCenterZoom(center, zoom, outW, outH);

  // ============================================================
  // FETCH + LAY OUT TILES (provider-specific)
  // ============================================================
  let tileBuffers;
  try {
    if (style.provider === 'mapbox' || style.provider === 'mapbox-custom') {
      tileBuffers = await fetchMapboxTiles({
        center, zoom, outW, outH, style, mapboxToken,
      });
    } else {
      return new Response(`Unknown provider: ${style.provider}`, { status: 400 });
    }
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

    // White background under everything (in case tiles have transparency)
    page.drawRectangle({
      x: 0, y: 0,
      width: pageWPts,
      height: pageHPts,
      color: rgb(1, 1, 1),
    });

    for (const t of tileBuffers) {
      try {
        const img = t.isJpeg
          ? await pdfDoc.embedJpg(t.buffer)
          : await pdfDoc.embedPng(t.buffer);

        page.drawImage(img, {
          x: t.xPts,
          y: t.yPts,
          width: t.widthPts,
          height: t.heightPts,
        });
      } catch (tileErr) {
        // Skip individual bad tiles rather than crash the whole PDF
        console.error(`Skipping bad tile at ${t.xPts},${t.yPts}: ${tileErr.message}`);
      }
    }

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
// MAPBOX FETCH (center+zoom-based static images)
// ============================================================
// Why center+zoom instead of bbox:
//   * bbox-based requests pad the image to maintain the URL's WxH
//     aspect ratio, which means the rendered area extends past the
//     bounds the user actually framed.
//   * bbox-based requests render labels at a "fit-to-image" size,
//     so a poster at 6000x4800 gets labels much smaller than what
//     the user saw at zoom 9 in the live preview.
//   * center+zoom requests render labels at their natural zoom-relative
//     size, exactly matching the live mapbox-gl preview.
async function fetchMapboxTiles({ center, zoom, outW, outH, style, mapboxToken }) {
  // Mapbox @2x means returned image is 2x logical size, so logical = pixels/2
  const totalLogicalW = Math.ceil(outW / 2);
  const totalLogicalH = Math.ceil(outH / 2);

  const cols = Math.ceil(totalLogicalW / MAPBOX_MAX_TILE_LOGICAL);
  const rows = Math.ceil(totalLogicalH / MAPBOX_MAX_TILE_LOGICAL);
  const tileLogicalW = Math.ceil(totalLogicalW / cols);
  const tileLogicalH = Math.ceil(totalLogicalH / rows);

  if (tileLogicalW > MAPBOX_MAX_TILE_LOGICAL || tileLogicalH > MAPBOX_MAX_TILE_LOGICAL) {
    throw new Error('Tile size exceeds Mapbox limits');
  }

  // Each tile is `tileLogicalW x tileLogicalH` logical px (= 2x pixel px @2x).
  // Total grid: rows*cols tiles. Compute center for each tile by offsetting
  // from the requested center using Web Mercator pixel math.
  //
  // At zoom z, 256 logical px = 360deg / 2^z of longitude (constant).
  // Latitude is non-linear (Mercator) — we go via mercator y, offset, invert.

  const totalPxW = cols * tileLogicalW;  // total grid in logical px
  const totalPxH = rows * tileLogicalH;

  const lngPerLogicalPx = 360 / (256 * Math.pow(2, zoom));

  // Page geometry in PDF points
  const pageHPts = outH * (72 / TARGET_DPI);
  const cellWPts = (outW / cols) * (72 / TARGET_DPI);
  const cellHPts = (outH / rows) * (72 / TARGET_DPI);

  // For latitude: convert center to Mercator Y (pixel coords at this zoom),
  // offset, convert back. Mercator Y formula:
  //   y_px = (1 - log(tan(lat) + sec(lat)) / PI) / 2 * 256 * 2^zoom
  function latToMercY(lat) {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 * Math.pow(2, zoom);
  }
  function mercYToLat(y) {
    const r = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (256 * Math.pow(2, zoom)))));
    return r * 180 / Math.PI;
  }

  const centerMercY = latToMercY(center.lat);

  const tileSpecs = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Tile's center in logical pixel offset from the overall center
      // (logical px relative to page-center-pixel-coordinate).
      const tileCenterPxX = (c + 0.5) * tileLogicalW - totalPxW / 2;
      const tileCenterPxY = (r + 0.5) * tileLogicalH - totalPxH / 2;

      const tileLng = center.lng + tileCenterPxX * lngPerLogicalPx;
      const tileLat = mercYToLat(centerMercY + tileCenterPxY);

      // Mapbox accepts up to 6 decimal precision for static image params
      const lonStr = tileLng.toFixed(6);
      const latStr = tileLat.toFixed(6);
      const zoomStr = zoom.toFixed(4);

      const url = `https://api.mapbox.com/styles/v1/${style.mapboxStylePath}/static/${lonStr},${latStr},${zoomStr},0/${tileLogicalW}x${tileLogicalH}@2x?access_token=${mapboxToken}&attribution=false&logo=false`;

      tileSpecs.push({
        url,
        isJpeg: style.isJpeg,
        xPts: c * cellWPts,
        // PDF y origin is bottom-left; row 0 is top of page, so flip.
        yPts: pageHPts - (r + 1) * cellHPts,
        widthPts: cellWPts,
        heightPts: cellHPts,
      });
    }
  }

  return await fetchAll(tileSpecs);
}

// ============================================================
// FETCH HELPERS
// ============================================================
async function fetchAll(specs) {
  return await Promise.all(specs.map(fetchOne));
}

async function fetchOne(spec) {
  const res = await fetch(spec.url);
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
  // Magic-byte sanity check
  const bytes = new Uint8Array(buffer);
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  if (!isPng && !isJpeg) {
    throw new Error(`Buffer is neither PNG nor JPEG (first bytes: ${[...bytes.slice(0,4)].map(b=>b.toString(16)).join(' ')})`);
  }
  return { ...spec, buffer };
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

// Compute the geographic bounds that a static map at the given center+zoom
// will cover, given output dimensions in pixels. Uses the same Web Mercator
// math as fetchMapboxTiles so the rendered area and these bounds match.
function computeBoundsFromCenterZoom(center, zoom, outW, outH) {
  const totalLogicalW = Math.ceil(outW / 2);
  const totalLogicalH = Math.ceil(outH / 2);

  const lngPerLogicalPx = 360 / (256 * Math.pow(2, zoom));
  const halfW = totalLogicalW / 2;
  const halfH = totalLogicalH / 2;

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
