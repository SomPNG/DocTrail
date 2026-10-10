import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../../db/client.js';
import { env } from '../../config/env.js';
import { AppError, ConflictError, UnauthorizedError } from '../../common/errors.js';
import type { Role } from '../../common/middleware.js';

export interface RegisterDto {
  email: string;
  password: string;
  name: string;
  role: Role;
  departmentCode?: string;
  badgeNumber?: string;
  phone?: string;
}

function toProfile(user: any) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    department: user.department?.name,
    departmentCode: user.department?.code,
    phone: user.phone,
  };
}

function signToken(userId: string) {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as any });
}

export class AuthService {
  /**
   * Creates a user. Public self-registration only ever reaches this with role CITIZEN;
   * staff accounts are created by an ADMIN through /api/admin/users.
   */
  static async register(dto: RegisterDto) {
    const existing = await prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (existing) throw new ConflictError('A user with this email address already exists');

    let departmentId: string | null = null;
    if (dto.role === 'OFFICER') {
      if (!dto.departmentCode) throw new AppError('Officers must belong to a department (departmentCode)', 400);
      const dept = await prisma.department.findUnique({ where: { code: dto.departmentCode } });
      if (!dept) throw new AppError(`Unknown department ${dto.departmentCode}`, 400);
      departmentId = dept.id;
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash,
        name: dto.name,
        role: dto.role,
        departmentId,
        badgeNumber: dto.badgeNumber,
        phone: dto.phone,
      },
      include: { department: true },
    });

    return { token: signToken(user.id), user: toProfile(user) };
  }

  static async login(email: string, password: string) {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, include: { department: true } });
    if (!user) throw new UnauthorizedError('Invalid email or password');
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) throw new UnauthorizedError('Invalid email or password');
    return { token: signToken(user.id), user: toProfile(user) };
  }
}
