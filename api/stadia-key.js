// /api/stadia-key.js
// Returns the Stadia Maps API key to the browser for use in MapLibre/Mapbox
// raster tile sources. The key should be domain-restricted in the Stadia
// dashboard (https://client.stadiamaps.com/dashboard/) so that even if the
// key is intercepted from network requests, it can't be used elsewhere.
//
// If STADIA_API_KEY isn't set, returns a 200 with key=null so the frontend
// can gracefully hide Stadia styles instead of crashing.

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const key = process.env.STADIA_API_KEY || null;

  return new Response(
    JSON.stringify({ key }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    }
  );
}
