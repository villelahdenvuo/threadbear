---
id: prHighlights
name: Pull requests in Highlights
title: Pull requests in Highlights: each PR a thread links to, with its status and an auto-fix wand
added: 2026-11-20
on: false
reminder: a3a0bff7
---

## What it does

Highlights gets a Pull requests section, above Links, for the GitHub pull requests a thread made, linked to or pinned. Each row has the PR's title and number, how long since it changed, and a line on what decides whether it can merge: CI passing, failing or running, approved, changes asked for or waiting for review, a merge conflict, and how many review threads are still open. Its icon is red when CI fails or changes are asked for, yellow while it waits on something, green when it's ready to merge, and grey as a draft. Each open PR has an auto-fix wand. Turn it on and Threadbear watches the PR every minute: a merge conflict, a failing check, an unresolved review thread, changes asked for, or a new review or comment from someone else is sent to the thread as a message to fix that PR. If `~/.threadbear/pr-auto-fix.md` is there, the message tells the thread to follow the rules in it. Once the PR is approved, the thread asks you whether to merge it; it never merges by itself. While the PRs a thread watches all wait for review, the thread is snoozed for a day. Merged and closed PRs are hidden under a "Show merged or closed" row at the foot of the section. A PR link isn't listed again under Links. Threadbear asks the `gh` command you're signed into, in one call for all of a thread's PRs, while Highlights is showing, at most every 30 seconds. Without `gh`, or signed out, the rows show without their status. Desktop (GPUI) app only.

## Lives in

`prStatus` in `runner/src/github-pr.ts`, the watch in `runner/src/pr-watch.ts` and `runner/src/runner/pr-watch.ts` (started in `start()`), the `github.prStatus`, `prWatch.set` and `prWatch.list` requests in `runner/src/rpc.ts`, `tb pr-watch` in `runner/src/cli.ts`, and `watched` on a PR highlight in `runner/src/runner/highlights.ts`. In the GPUI app: the section in `render_highlights` and `pr_status_row` (with its wand) in `desktop/gpui/src/highlights.rs`, the asking in `ask_pr_status` in `desktop/gpui/src/pr_view.rs`, and the words and colours in `PrStatus` in `desktop/core/src/pull_requests.rs`. The app learns it's on from `hello`'s `experiments`.

## Taking it out

Delete `prStatus` and its test, both `pr-watch.ts` files and `pr-watch.test.ts`, the `prWatch` fields and `armPrWatch` call in `runner.ts`, the three cases in `rpc.ts`, `prWatch.list` in `rpc-gate.ts`, `tb pr-watch`, the `watched` line in `runner/highlights.ts`, and their rows in `docs/protocol.md`. In the app delete `ask_pr_status`, the `status` maps in `PrPanes`, `pr_status_row`, `PrStatus` in `pull_requests.rs`, and the Pull requests section and `prs` in `HighlightSections`: PRs go back under Links.
