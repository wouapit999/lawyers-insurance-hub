import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { OtpService } from './otp.service';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { TokenService } from './token.service';

/**
 * Authentication and authorisation.
 *
 * PermissionsGuard is registered globally here rather than per-controller.
 * The default is therefore "authenticated and permission-checked", and a
 * route becomes public only by saying so with @Public(). Getting that default
 * backwards is how endpoints ship unprotected.
 */
@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_ACCESS_TTL', '15m') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    OtpService,
    JwtStrategy,
    // Order matters: authenticate first, then check permissions. Nest runs
    // APP_GUARD providers in registration order.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AuthService, TokenService, OtpService],
})
export class AuthModule {}
