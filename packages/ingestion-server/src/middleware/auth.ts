import { Request, Response, NextFunction } from 'express';

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = process.env.CODEGRAPH_API_KEY;
  if (!apiKey) {
    // If API Key is not set in environment, allow all requests (security disabled)
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.substring(7);
  if (token !== apiKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }

  next();
}
