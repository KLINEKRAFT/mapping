// /api/generate-pdf.js — v1.5
// New in v1.5:
//   * Style registry with three providers: mapbox, mapbox-custom (Studio forks),
//     and stadia (Stadia Maps slippy XYZ tiles, including Stamen).
//   * Slippy-tile pipeline for Stadia: computes the right zoom level for the
//     requested print resolution, fetches all tiles that intersect the bbox,
//     and drops each onto the PDF at exact lng/lat position via Web Mercator.
//     No canvas needed — pdf-lib handles every tile as a separate drawImage.

import { PDFDocument, rgb } from 'pdf-lib';

// Run on Node.js runtime (was Edge in earlier versions). Node.js gives us
// ~1 GB memory and a 60s timeout, which is needed for 16x20 satellite maps
// where pdf-lib has to embed multi-MB JPEG buffers without OOM.
export const maxDuration = 60;

// ============================================================
// STYLE REGISTRY
// ============================================================
// Each entry tells the renderer how to fetch tiles for this style.
//
//   provider: 'mapbox'         -> Mapbox Static Images API (bbox-based)
//   provider: 'mapbox-custom'  -> Same API, but with a user-defined Studio URL
//   provider: 'stadia'         -> Stadia Maps slippy XYZ tile pyramid
//
// To add a new Mapbox Studio fork:
//   1. Duplicate one of the standard styles in Mapbox Studio
//   2. Edit colors / typography / etc, save and publish
//   3. Copy the style URL (looks like mapbox://styles/USERNAME/STYLE_ID)
//   4. Add an entry to STYLE_REGISTRY with provider: 'mapbox-custom' and
//      mapboxStylePath: 'USERNAME/STYLE_ID'
//
// To add a new Stadia style:
//   1. Confirm the style ID at https://docs.stadiamaps.com/themes/
//   2. Add an entry with provider: 'stadia', stadiaStyle: 'style_id',
//      and isJpeg: true if the style only ships as JPEG (watercolor)

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

  // -- KLINEKRAFT MONOCHROME (Tier B, your Studio forks) -------------------
  // Replace null values below with your own published Studio style paths.
  // Format is 'username/styleid' (the part after mapbox://styles/).
  // Until you wire these up, the server will fall back to light-v11.
  'kk-sage-mono': {
    provider: 'mapbox-custom',
    mapboxStylePath: null,    // e.g. 'klinekraft/abc123sage'
    isJpeg: false,
  },
  'kk-cb-mono': {
    provider: 'mapbox-custom',
    mapboxStylePath: 'klinekraft/cmot54v7k00b401saabawemj2',
    isJpeg: false,
  },
  'kk-sepia': {
    provider: 'mapbox-custom',
    mapboxStylePath: null,    // e.g. 'klinekraft/abc123sepia'
    isJpeg: false,
  },
  'kk-slate-mono': {
    provider: 'mapbox-custom',
    mapboxStylePath: null,    // e.g. 'klinekraft/abc123slate'
    isJpeg: false,
  },

  // -- ARTISTIC (Tier C, Stadia Maps) --------------------------------------
  'stamen-watercolor': {
    provider: 'stadia',
    stadiaStyle: 'stamen_watercolor',
    isJpeg: true,
    maxZoom: 16,
  },
  'stamen-toner': {
    provider: 'stadia',
    stadiaStyle: 'stamen_toner',
    isJpeg: false,
    maxZoom: 20,
  },
  'stamen-toner-lite': {
    provider: 'stadia',
    stadiaStyle: 'stamen_toner_lite',
    isJpeg: false,
    maxZoom: 20,
  },
  'stamen-terrain': {
    provider: 'stadia',
    stadiaStyle: 'stamen_terrain',
    isJpeg: false,
    maxZoom: 18,
  },
  'stadia-outdoors': {
    provider: 'stadia',
    stadiaStyle: 'outdoors',
    isJpeg: false,
    maxZoom: 20,
  },
  'alidade-smooth': {
    provider: 'stadia',
    stadiaStyle: 'alidade_smooth',
    isJpeg: false,
    maxZoom: 20,
  },
  'alidade-smooth-dark': {
    provider: 'stadia',
    stadiaStyle: 'alidade_smooth_dark',
    isJpeg: false,
    maxZoom: 20,
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
const STADIA_TILE_PX = 512;             // @2x slippy tile = 512x512
const TARGET_DPI = 300;

// Fetches more than this in flight at once will be queued.
const STADIA_PARALLEL_BATCH = 16;

// ============================================================
// HANDLER
// ============================================================
async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const mapboxToken = process.env.MAPBOX_TOKEN;
  const stadiaKey = process.env.STADIA_API_KEY;

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
    } else if (style.provider === 'stadia') {
      if (!stadiaKey) {
        return new Response('STADIA_API_KEY not configured for this style', { status: 500 });
      }
      tileBuffers = await fetchStadiaTiles({
        bounds, outW, outH, style, stadiaKey,
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
// STADIA FETCH (slippy XYZ tile pyramid)
// ============================================================
async function fetchStadiaTiles({ bounds, outW, outH, style, stadiaKey }) {
  // 1. Pick a zoom level so that the print resolution is met or exceeded.
  //    At @2x, each tile is 512px. We want the bbox to span enough tiles
  //    that, when laid out across the page, the px-per-inch >= 300.

  const z = pickStadiaZoom(bounds, outW, style.maxZoom);

  // 2. Compute which tiles cover the bbox.
  const sw = lngLatToTileXY(bounds.west, bounds.south, z);
  const ne = lngLatToTileXY(bounds.east, bounds.north, z);

  const x0 = Math.floor(sw.x);
  const x1 = Math.floor(ne.x);
  const y0 = Math.floor(ne.y);
  const y1 = Math.floor(sw.y);

  const numTiles = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (numTiles > 600) {
    throw new Error(`Stadia would need ${numTiles} tiles — try a smaller area or page size`);
  }

  // 3. For each tile, work out where on the PDF page it goes.
  //    The tile occupies a known lng/lat bbox; map that to PDF points using
  //    the requested print bounds.
  const lngSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  const pageWPts = outW * (72 / TARGET_DPI);
  const pageHPts = outH * (72 / TARGET_DPI);

  const ext = style.isJpeg ? 'jpg' : 'png';
  const retina = style.isJpeg ? '' : '@2x';  // watercolor jpg has no retina variant in slippy
  const tileSpecs = [];

  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const tileBBox = tileXYToBBox(x, y, z);
      // Map this tile's geographic extent onto the PDF
      const x0Pts = ((tileBBox.west - bounds.west) / lngSpan) * pageWPts;
      const x1Pts = ((tileBBox.east - bounds.west) / lngSpan) * pageWPts;
      // Latitude is inverted: PDF y goes up, lat goes up too, so:
      const y0Pts = ((tileBBox.south - bounds.south) / latSpan) * pageHPts;
      const y1Pts = ((tileBBox.north - bounds.south) / latSpan) * pageHPts;

      const url = `https://tiles.stadiamaps.com/tiles/${style.stadiaStyle}/${z}/${x}/${y}${retina}.${ext}?api_key=${stadiaKey}`;

      tileSpecs.push({
        url,
        isJpeg: style.isJpeg,
        xPts: x0Pts,
        yPts: y0Pts,
        widthPts: x1Pts - x0Pts,
        heightPts: y1Pts - y0Pts,
      });
    }
  }

  return await fetchAllBatched(tileSpecs, STADIA_PARALLEL_BATCH);
}

// ============================================================
// FETCH HELPERS
// ============================================================
async function fetchAll(specs) {
  return await Promise.all(specs.map(fetchOne));
}

// Same as fetchAll but in batches, to avoid overwhelming Stadia
// when we need 50+ tiles.
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
// WEB MERCATOR (slippy tile) MATH
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
  const west  = (x      / n) * 360 - 180;
  const east  = ((x + 1) / n) * 360 - 180;
  const north = mercTileToLat(y,     n);
  const south = mercTileToLat(y + 1, n);
  return { west, east, north, south };
}

function mercTileToLat(y, n) {
  const rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  return rad * 180 / Math.PI;
}

// Pick a Stadia zoom level that, when its tiles are stretched to fit the
// requested print size, gives at least 300 DPI of tile resolution.
// We pick the smallest zoom that meets the threshold (so we use the fewest
// tiles), starting from zoom 0 and going up.
function pickStadiaZoom(bounds, printPxW, maxZoom = 20) {
  const lngSpan = bounds.east - bounds.west;
  for (let z = 0; z <= maxZoom; z++) {
    const tilesAcross = lngSpan / 360 * Math.pow(2, z);
    const tilePxAcross = tilesAcross * STADIA_TILE_PX;
    if (tilePxAcross >= printPxW) return z;
  }
  return maxZoom;
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
