import crypto from "node:crypto";

const secret = process.env.SESSION_SECRET ?? "development-only-ghost-secret";
const key = crypto.createHash("sha256").update(secret).digest();

export function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decrypt(value: string | null | undefined): string {
  if (!value) return "";
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) return "";
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
}

export function lookupHash(value: string): string {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

export function hashSetupCode(value: string): string {
  return lookupHash(value);
}

export function signOwnerSession(): string {
  const payload = `${Date.now()}.${crypto.randomBytes(18).toString("hex")}`;
  const signature = crypto.createHmac("sha256", key).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

export function verifyOwnerSession(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [timestamp, nonce, signature] = parts;
  const payload = `${timestamp}.${nonce}`;
  const expected = crypto.createHmac("sha256", key).update(payload).digest("hex");
  const age = Date.now() - Number(timestamp);
  return Number.isFinite(age) && age >= 0 && age < 1000 * 60 * 60 * 24 * 30 && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function randomSetupCode(): string {
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}