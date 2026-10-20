// Connexion Google et Apple (OpenID Connect, flux « authorization code » côté serveur).
// Les jetons d'identité sont vérifiés avec la bibliothèque éprouvée « jose » :
// signature (clés publiques du fournisseur), émetteur, audience, expiration et nonce.
import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } from "../vendor/jose.js";

const GOOGLE = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
};
const APPLE = {
  auth: "https://appleid.apple.com/auth/authorize",
  token: "https://appleid.apple.com/auth/token",
  jwks: "https://appleid.apple.com/auth/keys",
  issuers: ["https://appleid.apple.com"],
};
const jwksCache = {};
const jwks = (url) => (jwksCache[url] ||= createRemoteJWKSet(new URL(url)));

export function providersStatus(env) {
  return {
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    apple: !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY),
  };
}

export function redirectUri(origin, provider) { return `${origin}/auth/${provider}/callback`; }

export async function pkceChallenge(verifier) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}

export async function authorizationUrl(provider, env, origin, { state, nonce, codeVerifier }) {
  if (provider === "google") {
    const u = new URL(GOOGLE.auth);
    u.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(origin, "google"), response_type: "code",
      scope: "openid email profile", state, nonce, prompt: "select_account",
      code_challenge: await pkceChallenge(codeVerifier), code_challenge_method: "S256",
    });
    return u.toString();
  }
  const u = new URL(APPLE.auth);
  // Apple renvoie la réponse en POST (form_post) quand on demande le nom et le courriel.
  u.search = new URLSearchParams({
    client_id: env.APPLE_CLIENT_ID, redirect_uri: redirectUri(origin, "apple"), response_type: "code",
    response_mode: "form_post", scope: "name email", state, nonce,
  });
  return u.toString();
}

// Secret client Apple : un JWT ES256 signé avec la clé privée (.p8) gardée en secret côté serveur.
async function appleClientSecret(env) {
  const key = await importPKCS8(String(env.APPLE_PRIVATE_KEY).replace(/\\n/g, "\n"), "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: env.APPLE_KEY_ID })
    .setIssuer(env.APPLE_TEAM_ID).setSubject(env.APPLE_CLIENT_ID).setAudience("https://appleid.apple.com")
    .setIssuedAt(now).setExpirationTime(now + 300).sign(key);
}

// Échange du code contre les jetons, puis vérification du jeton d'identité.
export async function exchangeAndVerify(provider, env, origin, code, { nonce, codeVerifier }) {
  const P = provider === "google" ? GOOGLE : APPLE;
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(origin, provider) });
  if (provider === "google") {
    body.set("client_id", env.GOOGLE_CLIENT_ID); body.set("client_secret", env.GOOGLE_CLIENT_SECRET); body.set("code_verifier", codeVerifier);
  } else {
    body.set("client_id", env.APPLE_CLIENT_ID); body.set("client_secret", await appleClientSecret(env));
  }
  const r = await fetch(P.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  if (!r.ok) throw new OidcError("token_exchange", `Échange du code refusé par ${provider} (${r.status}).`);
  const tok = await r.json();
  if (!tok.id_token) throw new OidcError("no_id_token", "Le fournisseur n'a pas renvoyé de jeton d'identité.");
  let payload;
  try {
    ({ payload } = await jwtVerify(tok.id_token, jwks(P.jwks), {
      issuer: P.issuers, audience: provider === "google" ? env.GOOGLE_CLIENT_ID : env.APPLE_CLIENT_ID, clockTolerance: 60,
    }));
  } catch (e) { throw new OidcError("bad_id_token", "Jeton d'identité invalide : " + (e.code || e.message)); }
  if (!payload.sub) throw new OidcError("bad_id_token", "Identifiant du compte manquant.");
  if (payload.nonce !== nonce) throw new OidcError("bad_nonce", "Vérification de sécurité échouée (nonce).");
  const truthy = (v) => v === true || v === "true";
  return {
    provider, subject: String(payload.sub),
    email: payload.email ? String(payload.email).toLowerCase() : null,
    emailVerified: truthy(payload.email_verified),
    isPrivateEmail: truthy(payload.is_private_email) || /@privaterelay\.appleid\.com$/i.test(String(payload.email || "")),
    givenName: payload.given_name || null, familyName: payload.family_name || null,
    picture: typeof payload.picture === "string" && payload.picture.startsWith("https://") ? payload.picture : null,
  };
}

export class OidcError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

export function b64url(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function randomToken(n = 32) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }
export async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
