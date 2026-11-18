/**
 * Cloudflare Worker relay for Multi-Agent Project Room auth:
 *  - GET  /health        -> health check
 *  - GET  /google-certs  -> edge-cached proxy for Google OAuth JWKS public keys
 *  - POST /send-email    -> authenticated transactional email relay
 *                           (supports Resend free tier via RESEND_API_KEY, or
 *                            Cloudflare Email Service binding env.EMAIL on Paid plan)
 */

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const RESEND_API_URL = "https://api.resend.com/emails";

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

async function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) {
    return false;
  }
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const viewA = new Uint8Array(hashA);
  const viewB = new Uint8Array(hashB);
  let diff = 0;
  for (let i = 0; i < viewA.length; i += 1) {
    diff |= viewA[i] ^ viewB[i];
  }
  return diff === 0;
}

async function handleGoogleCerts() {
  const upstream = await fetch(GOOGLE_JWKS_URL, {
    cf: {
      cacheTtl: 3600,
      cacheEverything: true,
    },
  });
  if (!upstream.ok) {
    return jsonResponse({ error: "Upstream JWKS fetch failed" }, 502);
  }
  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

async function handleSendEmail(request, env) {
  const expectedSecret = (env.RELAY_SECRET || "").trim();
  if (!expectedSecret) {
    return jsonResponse({ error: "RELAY_SECRET not configured" }, 503);
  }

  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const authorized = await constantTimeEqual(token, expectedSecret);
  if (!authorized) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON payload" }, 400);
  }

  const to = typeof payload?.to === "string" ? payload.to.trim() : "";
  const fromEmail = typeof payload?.from_email === "string" ? payload.from_email.trim() : "";
  const fromName = typeof payload?.from_name === "string" ? payload.from_name.trim() : "Multi-Agent Project Room";
  const subject = typeof payload?.subject === "string" ? payload.subject.trim() : "";
  const text = typeof payload?.text === "string" ? payload.text : "";
  const html = typeof payload?.html === "string" ? payload.html : "";

  if (!to || !fromEmail || !subject || (!text && !html)) {
    return jsonResponse({ error: "Missing required email fields" }, 400);
  }

  const formattedFrom = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  // Path 1: Cloudflare Email Service binding (available on Workers Paid plans).
  if (env.EMAIL && typeof env.EMAIL.send === "function") {
    try {
      await env.EMAIL.send({
        to,
        from: formattedFrom,
        subject,
        text,
        html: html || undefined,
      });
      return jsonResponse({ sent: true, provider: "cloudflare_email" }, 200);
    } catch (err) {
      return jsonResponse(
        { error: "Cloudflare Email Service send failed", detail: String(err?.message || err) },
        502,
      );
    }
  }

  // Path 2: Resend HTTP API (compatible with Cloudflare Workers Free plan + Resend free 3,000/mo tier).
  const resendKey = (env.RESEND_API_KEY || "").trim();
  if (resendKey) {
    const resp = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: formattedFrom,
        to: [to],
        subject,
        text,
        html: html || undefined,
      }),
    });
    if (!resp.ok) {
      return jsonResponse({ error: "Resend upstream error", status: resp.status }, 502);
    }
    return jsonResponse({ sent: true, provider: "resend" }, 200);
  }

  return jsonResponse(
    { error: "No email transport configured (bind env.EMAIL or set RESEND_API_KEY)" },
    503,
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "mapr-auth-relay" });
    }
    if (request.method === "GET" && url.pathname === "/google-certs") {
      return handleGoogleCerts();
    }
    if (request.method === "POST" && url.pathname === "/send-email") {
      return handleSendEmail(request, env);
    }
    return jsonResponse({ error: "Not found" }, 404);
  },
};
