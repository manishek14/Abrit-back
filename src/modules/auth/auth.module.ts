import { Global, Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Admin } from '../../database/entities/admin.entity';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { getEnv } from '../../config/env';

/** Global so the APP_GUARD (JwtAuthGuard) can inject JwtService anywhere. */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: (): JwtModuleOptions => {
        const env = getEnv();
        return {
          global: true,
          secret: env.JWT_SECRET,
          signOptions: { expiresIn: env.JWT_EXPIRES_IN },
        } as JwtModuleOptions;
      },
    }),
    TypeOrmModule.forFeature([Admin]),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [JwtModule, AuthService],
})
export class AuthModule {}
