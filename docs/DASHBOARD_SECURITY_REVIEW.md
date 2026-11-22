# Dashboard Security Review

**Status:** Review completed; hardening is still required before production use.
**Reviewed:** 2026-11-23
**Scope:** `src/web/dashboard.js`, `src/app.js`, and `package.json` on `feature/marriage-system`.

## Current authentication design

- `POST /api/dashboard/login` accepts a single `DASHBOARD_PASSWORD`.
- Successful login returns a server-HMAC-signed bearer token with a 12-hour expiry.
- Protected routes validate the bearer token using `DASHBOARD_SESSION_SECRET`.
- The dashboard is currently pinned to `BARRACKS_GUILD_ID` (with a fallback guild ID), rather than accepting arbitrary guild IDs in API paths.
- `managerRoleIds` can be selected and persisted in guild settings, but the reviewed route handlers do not use those role IDs to authorize the logged-in person.
- The reviewed dependency list does not include an OAuth client or server-side session store.

## Findings

### High — shared-password login does not establish a Discord identity

A successful login proves only that the caller knows the shared dashboard password. The token payload contains an expiry and a dashboard scope, but no Discord user ID. Consequently, the server cannot verify that the caller is a current Barracks member or that they hold one of the configured Manager Roles.

**Required fix:** Replace the shared-password-only login with Discord OAuth2 Authorization Code flow using state validation and PKCE. After callback, identify the Discord account and verify current membership in the configured Barracks guild and possession of at least one configured Manager Role. Fail closed if the guild, member, or role check cannot be completed.

### High — moderation self-protection trusts a caller-supplied actor ID

In `POST /api/dashboard/moderation/action`, the target-member protection compares the target ID with `req.body.actorId`. That value is supplied by the request caller and is not tied to an authenticated Discord identity. It must not be used as the acting moderator identity.

**Required fix:** Derive the actor ID exclusively from the authenticated OAuth session. Reject attempts to moderate the authenticated actor, the guild owner, and the bot account. Record the authenticated actor ID and username in the moderation audit log.

### High — Manager Roles are settings, not an authorization boundary

The settings endpoint validates that selected Manager Role IDs exist in the guild, but the dashboard route authorization currently checks only the signed bearer token. The selected roles therefore do not restrict who can view or change dashboard settings, economy balances, moderation actions, roles/channels, clans, tickets, birthdays, or other dashboard features.

**Required fix:** Centralize authorization middleware and apply it to every `/api/dashboard/*` route. Re-fetch or otherwise verify the member's current guild roles for each protected request (with a deliberately short, invalidatable cache if needed). Deny access when no Manager Roles are configured, unless a separately documented owner-only bootstrap flow is implemented.

### Medium — bearer tokens have no individual revocation

The current token is self-contained and remains valid until its 12-hour expiry. There is no per-user session record or logout/revocation mechanism in the reviewed implementation.

**Required fix:** Use opaque, high-entropy session IDs stored server-side (preferably in the existing durable database), rotate on login, enforce idle and absolute expiry, and support logout/revocation. Never log OAuth access or refresh tokens.

### Medium — login throttling is process-local

The login attempt map is in memory. It resets on restart and is not shared between multiple bot processes or replicas.

**Required fix:** Apply shared rate limiting at the edge or in durable shared storage. Keep per-IP and per-account limits, and avoid trusting forwarded IP headers unless Express proxy trust is explicitly configured for the deployment.

## Implementation requirements / acceptance checklist

1. Discord OAuth2 callback validates a cryptographically random `state`, PKCE verifier/challenge, exact configured redirect URI, and expected token response.
2. OAuth scopes are the minimum needed for identity and guild membership/role verification. Do not rely on a client-provided user ID or role list.
3. Every dashboard API route is protected by one shared authentication + guild-membership + Manager Role authorization layer; public health/status endpoints remain separate.
4. The authenticated actor ID comes from the server-side session only. Client-supplied `actorId` is ignored or rejected.
5. Sessions use secure, HttpOnly cookies, an appropriate SameSite policy, HTTPS in production, and CSRF protection for cookie-authenticated state-changing requests.
6. Session identifiers rotate after authentication; logout revokes the session; role loss or guild departure denies the next protected request.
7. Guild identity remains pinned to the configured Barracks guild unless explicit multi-guild support is designed with per-guild authorization.
8. Add tests for OAuth state/PKCE failures, expired/revoked sessions, missing Manager Roles, role removal, guild departure, cross-guild access attempts, spoofed actor IDs, and every protected route.
9. Document the exact OAuth environment variables and Discord Developer Portal redirect URI only after the implementation and deployment URL are confirmed. Missing configuration must fail closed.

## Important deployment note

Do not remove the existing login flow or change the dashboard frontend until its current token storage and API request behavior have been migrated together. Do not merge or deploy this work until OAuth credentials, redirect URL, HTTPS cookie behavior, and staging verification are configured.
