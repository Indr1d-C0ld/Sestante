import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./sources.ts";

/** Personal keys live in .env and stay on the server: the browser only ever sees what they unlock. */
const values = new Map<string, string>();
const file = join(ROOT, ".env");
if (existsSync(file)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[2]) values.set(match[1]!, match[2]);
  }
}
for (const key of ["NASA_EARTHDATA_TOKEN", "COPERNICUS_CLIENT_ID", "COPERNICUS_CLIENT_SECRET", "NASA_FIRMS_MAP_KEY", "OPENWEATHER_API_KEY"]) {
  if (process.env[key]) values.set(key, process.env[key]!);
}

export const secret = (name: string) => values.get(name) ?? null;

/** FIRMS and OpenWeather want the key in the URL, so anything that may echo a URL passes through here first. */
export function scrub(text: string) {
  let out = text;
  for (const value of values.values()) if (value.length > 6) out = out.split(value).join("***");
  return out;
}

/** When a JWT stops working, from its own claim: no call to the service needed. */
export function jwtExpiry(token: string | null) {
  if (!token) return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { exp?: number };
    return claims.exp ? new Date(claims.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}
