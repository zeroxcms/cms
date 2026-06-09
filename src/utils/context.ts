// Shared Hono context type for the admin routes.

import type { Context } from 'hono';
import type { Env, Variables } from '../types';

export type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
