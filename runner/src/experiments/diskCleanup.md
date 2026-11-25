---
id: diskCleanup
name: Disk cleanup
title: Disk cleanup: Threadbear clears its own build output before the disk fills
added: 2026-11-25
on: false
reminder: 9145c7eb
---

## What it does

Threadbear clears its own build output so a full disk doesn't break builds and tests. In each thread worktree it deletes the Rust build folder (`desktop/target`, or any folder cargo marked as a cache that git ignores): in a spare worktree at once, in an archived thread's worktree that stays, and in an open thread's once it has been idle for two days. In `~/Library/Caches/Threadbear` it deletes `update-desktop/target`, `check-desktop-target` and the iPhone builds in `ios-builds`, and in `~/.cache/threadbear-check/local-builds` the shared build folders the landing check builds in, once they've gone unused for a week. It looks hourly. When the disk has under 10 GB free (checked every ten minutes and before each runner update build), it clears everything not in use at once, open threads idle for two hours included, until 20 GB is free. Nothing is touched while a thread's process, a `tb land`, a build or an update uses it, or while it was written in the last half hour. The next build there just starts from cold. It never touches your own files, the main checkout or a borrowed worktree.

## Lives in

`runner/src/disk-cleanup.ts`, made and started in `runner/src/main.ts` (beside the borrow sweep) and called before each update build through `beforeBuild` in `runner/src/update.ts`.

## Taking it out

Delete `runner/src/disk-cleanup.ts` and its test, the `DiskCleaner` lines in `main.ts`, and `beforeBuild` in `update.ts`. Nothing it deleted needs putting back: builds make it again.
