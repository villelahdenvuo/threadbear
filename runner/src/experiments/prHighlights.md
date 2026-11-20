---
id: prHighlights
name: Pull request status in Highlights
title: Pull request status in Highlights: each PR a thread links to, with CI, review, conflicts and open review threads
added: 2026-11-20
on: false
reminder: a3a0bff7
---

## What it does

Highlights gets a Pull requests section, above Links, for the GitHub pull requests a thread made, linked to or pinned. Each row has the PR's title and number, how long since it changed, and a line on what decides whether it can merge: CI passing, failing or running, approved, changes asked for or waiting for review, a merge conflict, and how many review threads are still open. Its icon is red when CI fails or changes are asked for, yellow while it waits on something, green when it's ready to merge, and grey as a draft. Merged and closed PRs are hidden under a "Show merged" row at the foot of the section. A PR link isn't listed again under Links. Threadbear asks the `gh` command you're signed into, in one call for all of a thread's PRs, while Highlights is showing, at most every 30 seconds. Without `gh`, or signed out, the rows show without their status. Desktop (GPUI) app only.

## Lives in

`prStatus` in `runner/src/github-pr.ts` and the `github.prStatus` request in `runner/src/rpc.ts`. In the GPUI app: the section in `render_highlights` and `pr_status_row` in `desktop/gpui/src/highlights.rs`, the asking in `ask_pr_status` in `desktop/gpui/src/pr_view.rs`, and the words and colours in `PrStatus` in `desktop/core/src/pull_requests.rs`. The app learns it's on from `hello`'s `experiments`.

## Taking it out

Delete `prStatus` and its test, the `github.prStatus` case in `rpc.ts`, and its row in `docs/protocol.md`. In the app delete `ask_pr_status`, the `status` maps in `PrPanes`, `pr_status_row`, `PrStatus` in `pull_requests.rs`, and the Pull requests section and `prs` in `HighlightSections`: PRs go back under Links.
