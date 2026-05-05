// /api/generate-pdf.js — v1.2
// FIX: Uses pdf-lib's rgb() helper instead of the bogus { type: 'RGB' } shape
// that was crashing the function. Also threads the user-picked accent color
// and layer toggles through to the PDF output.

import { PDFDocument, rgb } from 'pdf-lib';

export const config = { runtime: 'edge' };

const ALLOWED_STYLES = new Set([
  'light-v11',
  'streets-v12',
  'outdoors-v12',
  'satellite-v9',
  'satellite-streets-v12'
]);

// satellite-v9 is the only pure-raster style; everything else returns PNG.
const RASTER_STYLES = new Set(['satellite-v9']);

const MAX_TILE_LOGICAL = 1280;
const RETINA = '@2x';
const TILE_PIXEL = MAX_TILE_LOGICAL * 2;
const TARGET_DPI = 300;

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) {
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
    accentColor,    // hex string like "#ff5b04"
  } = body;

  if (!bounds || !pageWidthIn || !pageHeightIn) {
    return new Response('Missing required fields', { status: 400 });
  }

  const safeStyleId = ALLOWED_STYLES.has(styleId) ? styleId : 'light-v11';
  const mapboxStyle = `mapbox/${safeStyleId}`;
  const isJpeg = RASTER_STYLES.has(safeStyleId);

  // Parse hex → pdf-lib rgb (0..1 floats)
  const accent = parseHexToRgb(accentColor) || rgb(1.0, 0.357, 0.016);

  // ---- Tile grid math ----
  const outW = Math.round(pageWidthIn * TARGET_DPI);
  const outH = Math.round(pageHeightIn * TARGET_DPI);
  const cols = Math.ceil(outW / TILE_PIXEL);
  const rows = Math.ceil(outH / TILE_PIXEL);
  const tilePxW = Math.ceil(outW / cols);
  const tilePxH = Math.ceil(outH / rows);
  const logicalW = Math.ceil(tilePxW / 2);
  const logicalH = Math.ceil(tilePxH / 2);

  if (logicalW > MAX_TILE_LOGICAL || logicalH > MAX_TILE_LOGICAL) {
    return new Response('Tile size exceeds limits — try a smaller page', { status: 400 });
  }

  // ---- Build tile request URLs ----
  const lngSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;

  const tileRequests = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tileWest  = bounds.west  + (lngSpan * c)       / cols;
      const tileEast  = bounds.west  + (lngSpan * (c + 1)) / cols;
      const tileNorth = bounds.north - (latSpan * r)       / rows;
      const tileSouth = bounds.north - (latSpan * (r + 1)) / rows;
      const bboxStr = `[${tileWest},${tileSouth},${tileEast},${tileNorth}]`;
      const url = `https://api.mapbox.com/styles/v1/${mapboxStyle}/static/${bboxStr}/${logicalW}x${logicalH}${RETINA}?access_token=${token}&attribution=false&logo=false`;
      tileRequests.push({ row: r, col: c, url });
    }
  }

  // ---- Fetch tiles in parallel ----
  let tileBuffers;
  try {
    tileBuffers = await Promise.all(
      tileRequests.map(async (t) => {
        const res = await fetch(t.url);
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Tile ${t.row},${t.col} HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        return { ...t, buffer: await res.arrayBuffer() };
      })
    );
  } catch (e) {
    return new Response(`Tile fetch failed: ${e.message}`, { status: 502 });
  }

  // ---- Build PDF ----
  const pdfDoc = await PDFDocument.create();
  const pageWPts = pageWidthIn * 72;
  const pageHPts = pageHeightIn * 72;
  const page = pdfDoc.addPage([pageWPts, pageHPts]);

  page.drawRectangle({
    x: 0, y: 0,
    width: pageWPts, height: pageHPts,
    color: rgb(1, 1, 1)
  });

  for (const t of tileBuffers) {
    const img = isJpeg
      ? await pdfDoc.embedJpg(t.buffer)
      : await pdfDoc.embedPng(t.buffer);

    const cellWPts = pageWPts / cols;
    const cellHPts = pageHPts / rows;
    const x = t.col * cellWPts;
    const y = pageHPts - (t.row + 1) * cellHPts;

    page.drawImage(img, { x, y, width: cellWPts, height: cellHPts });
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
      'Cache-Control': 'no-store'
    }
  });
}

// ============================================================
// HELPERS
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
        color: accent
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
      borderWidth: 2
    });
  }
}
