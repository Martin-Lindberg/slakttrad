import jwt from "jsonwebtoken";

export type JwtUser = { sub: string; email: string };

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} saknas i env.`);
  return v;
}

const ACCESS_SECRET = () => mustEnv("JWT_ACCESS_SECRET");
const ACCESS_TTL_SECONDS = () => {
  const raw = mustEnv("JWT_ACCESS_TTL_SECONDS");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error("JWT_ACCESS_TTL_SECONDS måste vara ett positivt tal.");
  return n;
};

export function signAccessToken(user: JwtUser): string {
  return jwt.sign(user, ACCESS_SECRET(), { expiresIn: ACCESS_TTL_SECONDS() });
}

export function verifyAccessToken(token: string): JwtUser {
  const payload = jwt.verify(token, ACCESS_SECRET());
  if (typeof payload !== "object" || payload === null) throw new Error("Ogiltig token payload.");
  const sub = (payload as any).sub;
  const email = (payload as any).email;
  if (typeof sub !== "string" || typeof email !== "string") throw new Error("Token saknar sub/email.");
  return { sub, email };
}
