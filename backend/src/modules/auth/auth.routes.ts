import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import { validateBody, authenticate } from '../../common/middleware.js';
import { sendSuccess } from '../../common/utils.js';

const router = Router();

// Public self-registration is for citizens only. Staff accounts: POST /api/admin/users (ADMIN).
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2),
  role: z.literal('CITIZEN').default('CITIZEN'),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/register', validateBody(registerSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await AuthService.register({ ...req.body, role: 'CITIZEN' });
    sendSuccess(res, result, 'User registered successfully', 201);
  } catch (err) {
    next(err);
  }
});

router.post('/login', validateBody(loginSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await AuthService.login(req.body.email, req.body.password);
    sendSuccess(res, result, 'Login successful');
  } catch (err) {
    next(err);
  }
});

router.get('/me', authenticate, async (req: Request, res: Response) => {
  sendSuccess(res, req.user, 'Current user profile');
});

export default router;
