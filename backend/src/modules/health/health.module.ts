import { Controller, Get } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '../../common/auth/permissions.guard';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Kubernetes probes.
 *
 * `live` answers "is the process up" and must never touch a dependency — a
 * database blip should not get the pod killed and restarted, which would
 * make an outage worse. `ready` answers "should traffic come here" and does
 * check the database, because a pod that cannot reach Postgres should be
 * pulled from the load balancer until it can.
 */
@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  check(): { status: string; service: string; time: string } {
    return { status: 'ok', service: 'lih-api', time: new Date().toISOString() };
  }

  @Public()
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(): Promise<{ status: string; database: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up' };
    } catch {
      return { status: 'degraded', database: 'down' };
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
