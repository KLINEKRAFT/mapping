// /api/map-token.js — returns the public Mapbox access token to the
// frontend. Token comes from MAPBOX_TOKEN env var on Vercel.
async function handler() {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) return new Response('MAPBOX_TOKEN not configured', { status: 500 });
  return new Response(JSON.stringify({ token }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default { fetch: handler };
