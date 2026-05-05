// /api/generate-pdf.js
// Receives bounds + page size + optional selection from the browser.
// Calculates the tile grid needed for ~300 DPI output, requests tiles
// from the Mapbox Static Images API in parallel, stitches them into a
// single PNG, draws any selection overlay, and returns a PDF.

import { PDFDocument } from 'pdf-lib';

export const config = { runtime: 'edge' };

const MAPBOX_STYLE = 'mapbox/light-v11';
const MAX_TILE_LOGICAL = 1280;       // Mapbox limit per request
const RETINA = '@2x';                // doubles output resolution
const TILE_PIXEL = MAX_TILE_LOGICAL * 2; // 2560 with @2x
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

  const { bounds, pageWidthIn, pageHeightIn, selection } = body;

  if (!bounds || !pageWidthIn || !pageHeightIn) {
    return new Response('Missing required fields', { status: 400 });
  }

  // ---- Calculate output pixel dimensions at 300 DPI ----
  const outW = Math.round(pageWidthIn * TARGET_DPI);
  const outH = Math.round(pageHeightIn * TARGET_DPI);

  // ---- Determine tile grid ----
  const cols = Math.ceil(outW / TILE_PIXEL);
  const rows = Math.ceil(outH / TILE_PIXEL);

  // Per-tile pixel size (will be slightly less than TILE_PIXEL on the right/bottom edges)
  const tilePxW = Math.ceil(outW / cols);
  const tilePxH = Math.ceil(outH / rows);
  // Logical (non-retina) per-tile size for the API
  const logicalW = Math.ceil(tilePxW / 2);
  const logicalH = Math.ceil(tilePxH / 2);

  if (logicalW > MAX_TILE_LOGICAL || logicalH > MAX_TILE_LOGICAL) {
    return new Response('Tile size exceeds limits — try a smaller page', { status: 400 });
  }

  // ---- Build tile bounds (each cell is a sub-bbox of the full bounds) ----
  const lngSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;

  const tileRequests = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tileWest = bounds.west + (lngSpan * c) / cols;
      const tileEast = bounds.west + (lngSpan * (c + 1)) / cols;
      // Note: tile rows go top->bottom, latitude goes north->south
      const tileNorth = bounds.north - (latSpan * r) / rows;
      const tileSouth = bounds.north - (latSpan * (r + 1)) / rows;

      const bboxStr = `[${tileWest},${tileSouth},${tileEast},${tileNorth}]`;
      const url = `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE}/static/${bboxStr}/${logicalW}x${logicalH}${RETINA}?access_token=${token}&attribution=false&logo=false`;

      tileRequests.push({ row: r, col: c, url });
    }
  }

  // ---- Fetch all tiles in parallel ----
  let tileBuffers;
  try {
    tileBuffers = await Promise.all(
      tileRequests.map(async (t) => {
        const res = await fetch(t.url);
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Tile ${t.row},${t.col} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        const buf = await res.arrayBuffer();
        return { ...t, buffer: buf };
      })
    );
  } catch (e) {
    return new Response(`Tile fetch failed: ${e.message}`, { status: 502 });
  }

  // ---- Build PDF ----
  // Strategy: rather than pixel-stitch in the edge runtime (no <canvas>),
  // we embed each tile as a separate image positioned on the PDF page.
  // pdf-lib happily places PNGs at exact coordinates, and the printed
  // result is identical to a pre-stitched single image.
  const pdfDoc = await PDFDocument.create();

  // PDF user-space units are points (72 per inch)
  const pageWPts = pageWidthIn * 72;
  const pageHPts = pageHeightIn * 72;
  const page = pdfDoc.addPage([pageWPts, pageHPts]);

  // Fill page white (in case any tile fetch had transparent edges)
  page.drawRectangle({
    x: 0, y: 0,
    width: pageWPts, height: pageHPts,
    color: { type: 'RGB', red: 1, green: 1, blue: 1 }
  });

  for (const t of tileBuffers) {
    const img = await pdfDoc.embedPng(t.buffer);

    const cellWPts = pageWPts / cols;
    const cellHPts = pageHPts / rows;
    const x = t.col * cellWPts;
    // PDF y origin is bottom-left, our row 0 is the top of the page
    const y = pageHPts - (t.row + 1) * cellHPts;

    page.drawImage(img, {
      x,
      y,
      width: cellWPts,
      height: cellHPts
    });
  }

  // ---- Draw selection overlay (circle or rect) ----
  if (selection) {
    drawSelectionOverlay(page, selection, bounds, pageWPts, pageHPts);
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
// SELECTION OVERLAY HELPERS
// ============================================================
function lngLatToPagePts(lng, lat, bounds, pageWPts, pageHPts) {
  // Linear projection — fine for the small extents we deal with here.
  // For wider areas this would need a proper Web Mercator inverse,
  // but tile layouts at this scale make linear acceptable.
  const x = ((lng - bounds.west) / (bounds.east - bounds.west)) * pageWPts;
  const y = ((lat - bounds.south) / (bounds.north - bounds.south)) * pageHPts;
  return { x, y };
}

function drawSelectionOverlay(page, selection, bounds, pageWPts, pageHPts) {
  const accent = { type: 'RGB', red: 1.0, green: 0.357, blue: 0.016 }; // #ff5b04

  if (selection.type === 'circle') {
    const center = selection.center; // [lng, lat]
    const radiusMi = selection.radiusMi;

    // Generate polygon points and draw as a series of line segments
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

    // Stroke the circle
    for (let i = 0; i < pts.length - 1; i++) {
      page.drawLine({
        start: { x: pts[i].x, y: pts[i].y },
        end: { x: pts[i + 1].x, y: pts[i + 1].y },
        thickness: 2,
        color: accent
      });
    }

    // Center marker
    const c = lngLatToPagePts(center[0], center[1], bounds, pageWPts, pageHPts);
    page.drawCircle({
      x: c.x, y: c.y,
      size: 4,
      color: accent
    });
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
