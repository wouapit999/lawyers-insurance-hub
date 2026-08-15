import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { I18nContext } from 'nestjs-i18n';

import { IllegalTransitionError } from '@lih/domain';

/**
 * RFC 9457 `application/problem+json` error responses, localised.
 *
 * One shape for every failure, in the caller's language, with a correlation
 * id that also appears in the server log. When a lawyer in Douala calls
 * support about "erreur au paiement", support asks for the reference on
 * screen and finds the exact request.
 *
 * Internal details never cross the boundary: a Prisma error becomes a clean
 * 409 with a translated message, not a stack trace naming our tables.
 */

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  requestId: string;
  errors?: Record<string, string[]>;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request.headers['x-request-id'] as string) ?? 'unknown';
    const i18n = I18nContext.current();

    const t = (key: string, fallback: string, args?: Record<string, unknown>): string => {
      try {
        const translated = i18n?.t(key, { args }) as string | undefined;
        // nestjs-i18n echoes the key back when it has no entry for it.
        return !translated || translated === key ? fallback : translated;
      } catch {
        return fallback;
      }
    };

    const problem = this.toProblem(exception, request, requestId, t);

    // 5xx is our fault and gets the stack; 4xx is the caller's and does not
    // deserve log noise at error level.
    if (problem.status >= 500) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} -> ${problem.status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`[${requestId}] ${request.method} ${request.url} -> ${problem.status}`);
    }

    response
      .status(problem.status)
      .setHeader('Content-Type', 'application/problem+json')
      .setHeader('X-Request-Id', requestId)
      .json(problem);
  }

  private toProblem(
    exception: unknown,
    request: Request,
    requestId: string,
    t: (key: string, fallback: string, args?: Record<string, unknown>) => string,
  ): ProblemDetails {
    const base = { instance: request.url, requestId };

    // --- validation and other Nest HTTP exceptions -------------------------
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      let detail = exception.message;
      let errors: Record<string, string[]> | undefined;

      if (typeof body === 'object' && body !== null) {
        const asRecord = body as Record<string, unknown>;
        const message = asRecord.message;

        if (Array.isArray(message)) {
          // class-validator returns a flat array of messages; group them by
          // field so a form can highlight the right inputs.
          errors = {};
          for (const m of message as string[]) {
            const field = m.split(' ')[0] ?? '_';
            (errors[field] ??= []).push(m);
          }
          detail = t('errors.validation_failed', 'One or more fields are invalid');
        } else if (typeof message === 'string') {
          detail = message;
        }
      }

      return {
        type: `https://api.lih.cm/problems/${this.slug(status)}`,
        title: t(`errors.http.${status}`, HttpStatus[status] ?? 'Error'),
        status,
        detail,
        ...base,
        ...(errors ? { errors } : {}),
      };
    }

    // --- domain: illegal state transition ---------------------------------
    if (exception instanceof IllegalTransitionError) {
      return {
        type: 'https://api.lih.cm/problems/illegal-transition',
        title: t('errors.illegal_transition.title', 'Action not allowed in this state'),
        status: HttpStatus.CONFLICT,
        detail: t('errors.illegal_transition.detail', exception.message, {
          entity: exception.entity,
          from: exception.from,
          transition: exception.transition,
        }),
        ...base,
      };
    }

    // --- Prisma ------------------------------------------------------------
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception, base, t);
    }

    // --- anything else -----------------------------------------------------
    return {
      type: 'https://api.lih.cm/problems/internal',
      title: t('errors.internal.title', 'Internal server error'),
      detail: t(
        'errors.internal.detail',
        'Something went wrong on our side. Quote the reference below to support.',
      ),
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      ...base,
    };
  }

  private fromPrisma(
    e: Prisma.PrismaClientKnownRequestError,
    base: { instance: string; requestId: string },
    t: (key: string, fallback: string, args?: Record<string, unknown>) => string,
  ): ProblemDetails {
    switch (e.code) {
      case 'P2002': {
        // Unique constraint. The target names the column, which is safe to
        // surface — "this Bar number is already registered" is exactly what
        // the user needs to know.
        const target = (e.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
        return {
          type: 'https://api.lih.cm/problems/conflict',
          title: t('errors.conflict.title', 'Already exists'),
          detail: t('errors.conflict.duplicate', `A record with this ${target} already exists`, {
            field: target,
          }),
          status: HttpStatus.CONFLICT,
          ...base,
        };
      }
      case 'P2025':
        return {
          type: 'https://api.lih.cm/problems/not-found',
          title: t('errors.not_found.title', 'Not found'),
          detail: t('errors.not_found.detail', 'The requested record does not exist'),
          status: HttpStatus.NOT_FOUND,
          ...base,
        };
      case 'P2003':
        return {
          type: 'https://api.lih.cm/problems/invalid-reference',
          title: t('errors.invalid_reference.title', 'Invalid reference'),
          detail: t('errors.invalid_reference.detail', 'A referenced record does not exist'),
          status: HttpStatus.BAD_REQUEST,
          ...base,
        };
      default:
        return {
          type: 'https://api.lih.cm/problems/database',
          title: t('errors.internal.title', 'Internal server error'),
          detail: t('errors.internal.detail', 'A database error occurred'),
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          ...base,
        };
    }
  }

  private slug(status: number): string {
    return (HttpStatus[status] ?? 'error').toString().toLowerCase().replace(/_/g, '-');
  }
}
