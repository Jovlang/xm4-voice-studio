// Cloudflare Pages Function: relays the WH-1000XM4 voice packs and manifest from Sony's update CDN,
// which sends no CORS headers. Only the exact HP002 voice-pack/manifest paths are allowed, so this
// can't be used as a general-purpose proxy. (Dev equivalent: the Vite proxy in astro.config.mjs.)
const ALLOWED = /^\/HP002\/VGIDLPB04(0[1-9]|10)\/(info\/info\.xml|contents\/0002\/VP_[a-z]+_UPG_03\.bin)$/;

export const onRequestGet = async ({ request }: { request: Request }) => {
  const path = new URL(request.url).pathname.replace(/^\/sony/, "");
  if (!ALLOWED.test(path)) return new Response("Not found", { status: 404 });
  const upstream = await fetch(`https://info.update.sony.net${path}`, {
    cf: { cacheTtl: 86400, cacheEverything: true },
  } as RequestInit);
  if (!upstream.ok) return new Response("Upstream error", { status: 502 });
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
    },
  });
};
