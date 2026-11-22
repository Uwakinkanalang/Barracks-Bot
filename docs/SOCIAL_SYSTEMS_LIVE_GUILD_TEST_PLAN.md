# Barracks Social Systems — Live Guild Test Plan

This checklist is for a private staging Discord guild before PR #237 is merged or deployed to the production Barracks server.

## Safety setup

- [ ] Use a staging guild and test accounts; do not test fees or rewards with production member wallets.
- [ ] Back up the PostgreSQL database before testing.
- [ ] Confirm the bot is connected to PostgreSQL and not degraded in-memory mode.
- [ ] Configure the exact shared role name `💍B-Married` and the anniversary announcement channel in the dashboard.
- [ ] Place the bot's highest role above `💍B-Married`; grant Manage Roles and the required channel send/embed permissions.
- [ ] Keep proposal and divorce fees/rewards visible to testers before they interact.

## Friendship Center

- [ ] Post the Friendship Center panel using an account with Manage Server.
- [ ] Send a friend request; verify only the selected recipient can accept or decline.
- [ ] Verify the sender can cancel their own pending request.
- [ ] Verify duplicate requests and self-requests are rejected.
- [ ] Remove an accepted friend, then re-add them; verify points and original friendship date are restored.
- [ ] Block a member; verify requests and FP awards between the pair are prevented. Unblock and verify the documented behavior resumes.
- [ ] Verify chat FP requires meaningful back-and-forth activity and respects the per-pair daily cap.
- [ ] Verify voice FP only accrues while both non-bot members are actively present and not muted/deafened.
- [ ] Claim the +5 FP daily pair bonus; verify a second claim on the same Manila calendar day is rejected.
- [ ] Verify leaderboard and profile views only include active relationships where appropriate.

## Soulmates

- [ ] Verify members below 800 pair FP cannot send a Soulmate request.
- [ ] Verify a request requires recipient acceptance and only one active Soulmate per member is possible.
- [ ] Verify outgoing requests can be cancelled and incoming requests can be accepted/declined only by the recipient.
- [ ] End a Soulmate relationship; verify history remains and the seven-day cooldown is enforced.

## Marriage and economy

- [ ] Verify a proposal is rejected unless both members have at least 1,000 pair FP and an active Soulmate relationship.
- [ ] Verify the proposer is charged exactly 100,000 bCash once; acceptance is free.
- [ ] Verify only the recipient can accept/decline and only the proposer can cancel.
- [ ] Verify declined/expired proposals are not refunded and the re-proposal cooldown is enforced.
- [ ] Accept a proposal; verify one active marriage record and `💍B-Married` on both spouses.
- [ ] Verify each spouse receives their own +5,000 bCash through the existing daily claim, with no separate claim button.
- [ ] Open My Marriage, Relationship History, and Longest Marriages; verify names, dates, duration, couple FP, and reward totals.
- [ ] Initiate divorce and cancel the confirmation; verify no fee is charged and the marriage remains active.
- [ ] Confirm divorce; verify only the initiator pays 100,000 bCash, both lose the married role, both receive the seven-day cooldown, and history remains.
- [ ] Verify insufficient wallet funds prevent divorce without changing the marriage.

## Anniversary and recovery

- [ ] In staging only, create a test marriage with a wedding timestamp at least one year in the past.
- [ ] Run the anniversary processor; verify each spouse receives exactly 1,000,000 bCash and the configured channel receives one announcement.
- [ ] Run the processor again; verify no duplicate payment or announcement.
- [ ] Simulate one spouse wallet write failing; rerun after recovery and verify only the unpaid spouse is credited.
- [ ] Temporarily remove the bot's Manage Roles permission; verify role reconciliation reports/retries the mismatch once permissions are restored.
- [ ] Restart the bot and verify relationship history, pending requests, cooldowns, and anniversary receipts persist.

## Release gate

- [ ] All applicable checks above pass in staging.
- [ ] No unresolved critical/high-severity defects remain.
- [ ] Latest GitHub Actions workflows pass on the final PR head.
- [ ] Production backup and rollback plan are ready.
- [ ] A maintainer explicitly approves merge and production deployment.

**Do not use production accounts or real member balances for simulated anniversary, fee, or failure-injection tests.**
