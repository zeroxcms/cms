// ============================================================
// Audit logging for admin mutations.
//
// Fire-and-forget via waitUntil so a logging failure can never
// break the mutation it records. Detail payloads should stay
// small (slugs, filenames) — never content bodies.
// ============================================================

import type { AppContext } from './context';

export function logAudit(
  c: AppContext,
  action: string,
  entityType: string,
  entityId?: string | number,
  detail?: Record<string, unknown>,
): void {
  const user = c.get('user');
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO audit_log (user_id, user_email, action, entity_type, entity_id, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        String(user.sub),
        user.email,
        action,
        entityType,
        entityId === undefined ? null : String(entityId),
        detail ? JSON.stringify(detail) : null,
      )
      .run()
      .catch((error) => console.error('audit log failed', error)),
  );
}
