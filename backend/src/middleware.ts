import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, type JwtUser } from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: JwtUser;
    }
  }
}

export function authGuard(req: Request, res: Response, next: NextFunction) {
  const header = req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Du måste vara inloggad." });
  }
  const token = header.slice("Bearer ".length).trim();
  try {
    req.user = verifyAccessToken(token);
    return next();
  } catch {
    return res.status(401).json({ error: "Ogiltig eller utgången token." });
  }
}
