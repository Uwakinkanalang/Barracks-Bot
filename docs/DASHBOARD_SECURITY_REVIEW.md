# Dashboard Security Review

**Status:** Core Discord OAuth authentication and authorization hardening implemented on the feature branch. Production configuration and end-to-end staging verification remain outstanding.
**Reviewed:** 2026-11-23
**Scope:** `src/web/dashboard.js`, dashboard frontend, and related configuration on `feature/marriage-system`.

## Current authentication design

- The legacy shared-password endpoint returns HTTP 410; password login is retired.
- The frontend starts Discord OAuth2 Authorization Code flow using state and PKCE S256 with the minimum `identify` scope.
- The callback exchanges the authorization code, obtains the Discord identity, and checks current Barracks guild membership and configured Manager Role membership.
- The server owner is the bootstrap exception and is the only user permitted to configure Manager Roles.
- The dashboard is pinned to `BARRACKS_GUILD_ID`; callers cannot select an arbitrary guild.
- A signed 12-hour bearer token contains the Discord user ID and a random session ID. The session record is persisted in the database and checked on each protected request.
- Logout revokes the persistent session. Loss of guild membership or Manager Role blocks protected access; logout remains available so a user can revoke their own session.
- Moderation actions use the authenticated server-derived actor identity, not a client-supplied actor ID.

## Findings and remaining risks

### High — shared-password login did not establish a Discord identity — addressed in branch

The password endpoint is retired. OAuth callback verification establishes a Discord identity and checks live guild membership and configured Manager Role membership. Missing OAuth configuration fails closed.

### High — Manager Role enforcement — addressed in branch

Centralized middleware verifies the signed token, persistent session, current guild membership, and current Manager Role on protected API requests. The owner is the only bootstrap exception and the only user allowed to change Manager Role configuration.

### High — moderation actor identity — addressed in branch

Moderation self-protection and audit records use the authenticated Discord identity. The client cannot select the actor ID.

### Medium — browser token storage and XSS exposure — outstanding

The frontend stores the dashboard bearer token in `sessionStorage`. This is safer than persistent local storage but remains accessible to JavaScript executing in the page. A same-origin XSS flaw could steal an active token. Prefer an HttpOnly, Secure, SameSite cookie-backed session with CSRF protection, and maintain a strict content security policy.

### Medium — OAuth attempt throttling is process-local — outstanding

OAuth start attempts are limited in process memory and reset on restart; they are not shared across replicas. Keep the service to one application replica until shared rate limiting is introduced. Do not trust forwarded IP headers unless proxy trust is explicitly configured.

### Low — expired session record cleanup — implemented in branch

A scheduled job runs every six hours and removes expired `dashboard:sessions:` records from the persistent database. The cleanup skips safely when the database is unavailable or degraded. Expired sessions are also rejected on every protected request, so the scheduled job is storage housekeeping rather than an authentication control.

## Implementation and acceptance checklist

1. OAuth state and PKCE S256 are implemented; the callback uses the configured redirect URI and `identify` scope. The OAuth access token is not stored or logged.
2. The frontend removes the bearer token from the URL fragment and stores it in `sessionStorage`; logout calls the server to revoke the persistent session.
3. Protected `/api/dashboard/*` endpoints pass through centralized signed-token, persistent-session, live guild membership, and Manager Role checks.
4. The guild owner can bootstrap the first Manager Role and is the only user who can later change Manager Role configuration.
5. Moderation actions use authenticated actor identity and audit records include moderator ID and username.
6. Sessions are random, server-backed, revocable, and expire after 12 hours. Persistent database availability is required; degraded/in-memory mode is denied.
7. The frontend is hosted on GitHub Pages and calls the Railway API over HTTPS. The frontend/API migration must be deployed together.
8. Before production: configure `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DASHBOARD_OAUTH_REDIRECT_URI`, `DASHBOARD_SESSION_SECRET`, and `DASHBOARD_FRONTEND_URL` in Railway; add the exact callback URL in the Discord Developer Portal; verify `CORS_ORIGIN`; and run end-to-end OAuth, role-loss, and logout tests against staging.
9. Expand automated route-level tests for invalid state/PKCE, expired/revoked sessions, no Manager Roles, role removal, guild departure, owner bootstrap, spoofed actor IDs, and protected endpoints.
10. Move to an HttpOnly cookie-backed session with CSRF protection and introduce shared rate limiting before scaling beyond one application instance. The six-hour expired-session pruning job is implemented; verify it against staging database data before production.

## Deployment gate

Do not merge or deploy until OAuth credentials and the redirect URI are configured in Railway and the Discord Developer Portal, then verify the GitHub Pages frontend and Railway API together in staging. No production deployment or merge is authorized by this review.
