---
title: Maintenance
description: The system check and scheduled cleanup tasks in Settings → Admin → Maintenance.
---

**Settings → Admin → Maintenance** (**Settings → Maintenance** in the desktop app) shows whether the instance is healthy and runs its background cleanup.

## System check

The system check tests the instance from both the server and your browser:

| Check | What it confirms |
| --- | --- |
| Compute worker | The app can reach the worker. |
| Object storage | The storage bucket is reachable. |
| Playback secret | A playback signing secret is available. |
| Providers | At least one shared TTS provider is enabled. |
| Address you opened | The address in your browser matches `BASE_URL`. |
| Playback audio URL | Your browser can reach the worker's playback address, and it is not blocked as mixed content. |

Each row reads **OK**, **Check** or **Fix**. Rows that are not OK say what is wrong and which setting fixes it. Choose **Run again** after changing configuration.

The desktop app adds **Open logs folder** here.

## Scheduled tasks

| Task | Default interval | What it does |
| --- | --- | --- |
| Clean up unowned documents | 6 hours | Removes document files and generated artifacts that no longer have an owner. |
| Clean up expired uploads | 1 hour | Removes temporary uploads that were never finished and DOCX conversions older than a day. |
| Clean up expired exports | 1 day | Removes account export ZIPs after seven days. Audiobooks are kept until their audio is cleared. |
| Clean up compute history | 1 day | Releases expired compute leases and removes old limit counters and events. |
| Retry storage cleanup | 15 minutes | Deletes audio and exports left by deleted documents and accounts. Retries cleanups that failed and runs a second pass after an account is deleted. |
| Delete idle guest accounts | 1 day | Off by default. Deletes guests whose account and sessions have been idle for the **Guest idle period** (90 days by default, under Guest sessions), and resumes previously requested deletions. |
| Finish pending account deletions | 15 minutes | Retries account deletions interrupted by a restart or failed cleanup. On Vercel it runs with the daily cron. |
| Find leftover storage | 10 minutes | Runs once. Queues cleanup for audio and exports left by deletes before this version, then turns itself off. |

You can turn each task on or off, change its interval, or run it now. Storage cleanup and account deletion run as durable jobs on the compute worker. The panel shows live progress and the final result, including failed items. You can leave the page while a job continues; opening Maintenance again reconnects to its progress. Compute-history cleanup stays in the app because it only changes the application database.

The web request only queues a job. The worker performs storage scans and deletes, and makes short authenticated calls to the app for database ownership checks and row cleanup. A web request ending or a progress stream reconnecting does not cancel the job.

Waiting behind another maintenance sweep does not expire a queued cleanup. The panel refreshes its task list to discover scheduled runs; detailed cleanup progress uses SSE. Last-run times and durations reflect worker completion, even when the app learns about completion later.

Account deletion first revokes sessions and displays **Deletion pending** in Users. The account and its ownership rows are removed after storage cleanup succeeds. Failed deletions retain that marker and can be retried with **Finish pending account deletions**. Selecting multiple users queues one cleanup job for the selection. Deleting your own account from **Settings → Account**, and the guest left behind when a guest signs up or signs in, go through the same job.

Only one copy of a task runs at a time, even with several app instances.

### How tasks are triggered

- **Self-hosted and desktop**: the app checks for due tasks every minute.
- **Vercel**: there is no long-running server, so Vercel Cron calls `/api/admin/tasks/tick`. Set `CRON_SECRET`; requests without it are rejected. The included schedule runs once a day (the most Vercel Hobby allows), so intervals shorter than a day are not offered there.

Vercel intervals are anchored to the UTC day of the run. A job finishing after the cron request or being reconciled the following day does not postpone the next daily run.
