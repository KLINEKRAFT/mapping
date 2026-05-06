// /api/map-token.js
// Returns the public Mapbox token to the browser.
// The token itself is restricted to the maps.colinkline.com referer
// in the Mapbox dashboard, so even if exposed it can't be used elsewhere.

async function handler(request) {
  const token = process.env.MAPBOX_TOKEN;

  if (!token) {
    return new Response(
      JSON.stringify({ error: 'MAPBOX_TOKEN env var not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ token }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300'
      }
    }
  );
}

export default { fetch: handler };
