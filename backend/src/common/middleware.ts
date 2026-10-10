import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { UnauthorizedError, ForbiddenError, AppError } from './errors.js';
import { prisma } from '../db/client.js';
import { ZodSchema, ZodError } from 'zod';

export type Role = 'CITIZEN' | 'OFFICER' | 'SUPERVISOR' | 'ADMIN';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  departmentId?: string | null;
  departmentCode?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function resolveUserFromToken(token: string): Promise<AuthUser | null> {
  const payload = jwt.verify(token, env.JWT_SECRET) as { userId: string };
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    include: { department: true },
  });
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    departmentId: user.departmentId,
    departmentCode: user.department?.code ?? null,
  };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }

    const user = await resolveUserFromToken(authHeader.split(' ')[1]);
    if (!user) {
      throw new UnauthorizedError('User associated with token not found');
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      next(new UnauthorizedError('Invalid or expired token'));
    } else {
      next(error);
    }
  }
}

export function authorize(roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError('Not authenticated'));
    }
    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError(`Role ${req.user.role} is not permitted to perform this action`));
    }
    next();
  };
}

/** Blocks a route unless a feature flag is on (e.g. demo reset, simulation). */
export function requireFlag(flag: boolean, name: string) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    if (!flag) return next(new ForbiddenError(`${name} is disabled in this environment`));
    next();
  };
}

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body ?? {});
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(422).json({
          success: false,
          message: 'Validation failed',
          errors: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
        });
        return;
      }
      next(err);
    }
  };
}

export function errorHandler(err: Error & { code?: string }, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      details: err.details,
    });
    return;
  }

  // Multer upload errors (file too large, rejected type, ...)
  if (err.name === 'MulterError' || err.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ success: false, message: `Upload rejected: ${err.message}` });
    return;
  }

  console.error('Unhandled Server Error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
}
