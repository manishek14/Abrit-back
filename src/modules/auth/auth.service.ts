import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { Admin } from '../../database/entities/admin.entity';

export interface AdminPublic {
  id: string;
  email: string;
  name: string;
}

export interface LoginResult {
  accessToken: string;
  admin: AdminPublic;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Admin) private readonly admins: Repository<Admin>,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string): Promise<LoginResult> {
    const admin = await this.admins.findOne({
      where: { email: email.trim().toLowerCase() },
    });
    if (!admin) throw new UnauthorizedException('Invalid email or password');

    const passwordOk = await bcrypt.compare(password, admin.password_hash);
    if (!passwordOk) throw new UnauthorizedException('Invalid email or password');

    const accessToken = await this.jwt.signAsync({
      sub: admin.id,
      email: admin.email,
      name: admin.name,
    });
    return { accessToken, admin: { id: admin.id, email: admin.email, name: admin.name } };
  }
}
