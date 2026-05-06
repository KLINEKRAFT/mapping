// /api/generate-pdf.js — v1.7.0
//   * 7 KK Carto Studio styles wired (Light / Bright / Heritage / Mist /
//     Midnight / KK Carto / CB Blue Mono)
//   * Stadia provider removed entirely
//   * Mapbox bbox-based static images for all map styles

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
const MAPBOX_TILE_PIXEL = MAPBOX_MAX_TILE_LOGICAL * 2;
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
    pageWidthIn,
    pageHeightIn,
    selection,
    styleId,
    accentColor,
  } = body;

  if (!bounds || !pageWidthIn || !pageHeightIn) {
    return new Response('Missing required fields', { status: 400 });
  }

  const style = resolveStyle(styleId);
  const accent = parseHexToRgb(accentColor) || rgb(1.0, 0.357, 0.016);

  const outW = Math.round(pageWidthIn * TARGET_DPI);
  const outH = Math.round(pageHeightIn * TARGET_DPI);

  // ============================================================
  // FETCH + LAY OUT TILES (provider-specific)
  // ============================================================
  let tileBuffers;
  try {
    if (style.provider === 'mapbox' || style.provider === 'mapbox-custom') {
      tileBuffers = await fetchMapboxTiles({
        bounds, outW, outH, style, mapboxToken,
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
      drawSelectionOverlay(page, selection, bounds, pageWPts, pageHPts, accent);
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
// MAPBOX FETCH (bbox-based static images)
// ============================================================
async function fetchMapboxTiles({ bounds, outW, outH, style, mapboxToken }) {
  const cols = Math.ceil(outW / MAPBOX_TILE_PIXEL);
  const rows = Math.ceil(outH / MAPBOX_TILE_PIXEL);
  const tilePxW = Math.ceil(outW / cols);
  const tilePxH = Math.ceil(outH / rows);
  const logicalW = Math.ceil(tilePxW / 2);
  const logicalH = Math.ceil(tilePxH / 2);

  if (logicalW > MAPBOX_MAX_TILE_LOGICAL || logicalH > MAPBOX_MAX_TILE_LOGICAL) {
    throw new Error('Tile size exceeds Mapbox limits');
  }

  const lngSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  const cellWPts = (outW / cols) * (72 / TARGET_DPI);
  const cellHPts = (outH / rows) * (72 / TARGET_DPI);
  const pageHPts = outH * (72 / TARGET_DPI);

  const tileSpecs = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tileWest  = bounds.west  + (lngSpan * c)       / cols;
      const tileEast  = bounds.west  + (lngSpan * (c + 1)) / cols;
      const tileNorth = bounds.north - (latSpan * r)       / rows;
      const tileSouth = bounds.north - (latSpan * (r + 1)) / rows;
      const bboxStr = `[${tileWest},${tileSouth},${tileEast},${tileNorth}]`;
      const url = `https://api.mapbox.com/styles/v1/${style.mapboxStylePath}/static/${bboxStr}/${logicalW}x${logicalH}@2x?access_token=${mapboxToken}&attribution=false&logo=false`;
      tileSpecs.push({
        url,
        isJpeg: style.isJpeg,
        xPts: c * cellWPts,
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
