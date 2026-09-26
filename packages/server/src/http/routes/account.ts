import {
  API_ROUTES,
  DeleteAccountRequestSchema,
  WRONG_PASSWORD_MESSAGE,
} from '@agentnomad/contracts';
import { Hono } from 'hono';

import { InvalidCredentialsError, type AuthService } from '../../auth/auth-service.ts';
import { fromBase64 } from '../../encoding.ts';
import { ApiError } from '../errors.ts';
import { requireSession, type SessionVariables } from '../session.ts';
import { smallBody } from '../small-body.ts';
import { jsonBody } from '../validate.ts';

/** DELETE /account (T17): needs a session and the auth key. */
export function accountRoutes(auth: AuthService): Hono<{ Variables: SessionVariables }> {
  return new Hono<{ Variables: SessionVariables }>().delete(
    API_ROUTES.account,
    smallBody(),
    requireSession(auth),
    jsonBody(DeleteAccountRequestSchema),
    async (c) => {
      const { authKey } = c.req.valid('json');
      try {
        await auth.deleteAccount(c.get('session').userId, fromBase64(authKey));
      } catch (error) {
        if (error instanceof InvalidCredentialsError) {
          throw new ApiError(401, 'unauthorized', WRONG_PASSWORD_MESSAGE);
        }
        throw error;
      }
      return c.body(null, 204);
    },
  );
}
