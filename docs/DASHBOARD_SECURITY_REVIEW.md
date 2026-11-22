# Dashboard Security Review

**Status:** OAuth/frontend integration and core authorization hardening implemented on the feature branch; production configuration and staging verification remain outstanding.
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

### High — shared-password login did not establish a Discord identity — addressed in branch

The dashboard frontend now starts Discord OAuth2 Authorization Code flow with state and PKCE; the password login endpoint is retired. The callback exchanges the code, obtains the Discord identity, and verifies live Barracks guild membership and configured Manager Role membership. The server owner can enter during initial setup to configure the first Manager Role. Missing OAuth configuration fails closed.

### High — moderation actor identity — addressed in branch

Moderation self-protection compares the target against the authenticated server-derived Discord identity. The client cannot choose the actor ID. Dashboard moderation log entries now record the authenticated moderator ID and username for all actions.

### High — Manager Role enforcement — addressed in branch

A shared `/api/dashboard` middleware verifies the signed session, persistent session record, current guild membership, and current configured Manager Role on every protected request. The guild owner is the only bootstrap exception and is the only user allowed to change Manager Role configuration. Guild identity remains pinned to the configured Barracks guild.

### Medium — individual session revocation — partially addressed in branch

Each OAuth login now creates a cryptographically random session ID backed by the persistent database. Every protected request checks the session record, and logout revokes it. The session and signed bearer token expire after 12 hours. Sessions fail closed if the persistent database is degraded. A scheduled pruning job for expired session records is still recommended.

### Medium — OAuth attempt throttling is process-local — outstanding

OAuth start attempts are limited per IP in process memory and the global Express API rate limit is also process-local. These limits reset on restart and are not shared between replicas. Keep the service to one replica until shared rate limiting is introduced; do not trust forwarded IP headers unless proxy trust is explicitly configured.

## Implementation and remaining acceptance checklist

1. OAuth state and PKCE S256 are implemented; the callback uses the configured redirect URI and the minimum `identify` scope. The OAuth access token is not stored or logged.
2. The frontend now uses Discord sign-in, stores the short-lived dashboard bearer token in session storage, removes it from the URL fragment immediately, and calls the logout endpoint to revoke the server-side session.
3. All `/api/dashboard/*` endpoints pass through centralized signed-token, persistent-session, live guild membership, and Manager Role checks. The configured Barracks guild is pinned server-side.
4. The guild owner can bootstrap the first Manager Role and is the only user who can later change Manager Role configuration.
5. Moderation actions use authenticated actor identity and audit records include moderator ID and username.
6. Session identifiers are random, server-backed, revocable, and expire after 12 hours. Persistent database availability is required; degraded/in-memory mode is denied.
7. The frontend is hosted on GitHub Pages and calls the Railway API over HTTPS. The frontend/API migration must be deployed together.
8. Still required before production: configure `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DASHBOARD_OAUTH_REDIRECT_URI`, `DASHBOARD_SESSION_SECRET`, and `DASHBOARD_FRONTEND_URL` in Railway; add the exact callback URL in the Discord Developer Portal; verify `CORS_ORIGIN`; and run end-to-end OAuth/role-loss/logout tests against staging.
9. Add automated route-level tests for invalid state/PKCE, expired/revoked sessions, no Manager Roles, role removal, guild departure, owner bootstrap, spoofed actor IDs, and protected endpoints.
10. Introduce shared rate limiting and expired-session pruning before scaling beyond one application instance.

## Important deployment note

Password login has been retired on this feature branch and the frontend has been migrated with it. Do not merge or deploy until the OAuth credentials and redirect URI are configured in Railway and the Discord Developer Portal, then verify the GitHub Pages frontend and Railway API together in staging. No production deployment or merge has been performed.
