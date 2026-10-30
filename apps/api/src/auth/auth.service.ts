import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../common/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { LoginDto, RegisterDto } from './auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private activity: ActivityLogService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('An account with this email already exists');
    }
    const user = await this.prisma.user.create({
      data: { name: dto.name.trim(), email, passwordHash: await bcrypt.hash(dto.password, 12) },
    });
    await this.activity.log(user.id, 'user.registered');
    return this.issue(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    // Same error for unknown email and wrong password to avoid account enumeration.
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    await this.activity.log(user.id, 'user.login');
    return this.issue(user);
  }

  private async issue(user: { id: string; email: string; name: string; avatarUrl: string | null }) {
    const token = await this.jwt.signAsync({ sub: user.id, email: user.email });
    return {
      token,
      user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl },
    };
  }
}
