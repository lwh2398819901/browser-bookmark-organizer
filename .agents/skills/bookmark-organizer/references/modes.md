# First-time cleanup

1. Obtain a browser HTML export or a copy of Chromium's `Bookmarks` file. Preserve the input unchanged.
2. Run the audit without `--check-links`. Review exact duplicates, folder distribution, domain distribution, and malformed URLs.
3. If link checking is requested, run it in a separate pass. A non-2xx status alone is not enough to delete a bookmark: login-gated sites, rate limits, and bot protection are common.
4. Read pages only for bookmarks whose folder cannot be determined from their existing context, title, hostname, and deterministic report. Keep meaningful existing folder groupings unless their content demonstrates they are misplaced.
5. Present a per-bookmark proposal for deletion, renaming, and relocation. Apply only the approved plan. For imports, create a new HTML output; for a live browser, use its bookmarks API.

# Recurring temporary folder

`临时收藏` is an inbox, not a permanent category.

1. Re-scan it immediately before handling it.
2. Compare exact URLs against the entire collection. If an exact duplicate exists elsewhere, report its existing path and remove the inbox copy only when that behavior was already authorized. URL fragments often denote a specific chapter or heading, so treat differing fragments as related references, not duplicates.
3. Read the remaining pages as needed, select an existing folder where it fits, and create a narrowly named folder only when no stable category exists.
4. Submit a single validated batch plan. Confirm that all moved IDs left `临时收藏` and that the destination paths exist.

# Profile and change detection

The generated HTML profile should describe the collection, not infer private traits beyond bookmark evidence. It may show:

- bookmark count, folder count, top folders, and top domains;
- topic distribution inferred from folder paths;
- exact and normalized duplicate groups;
- availability-check results, including unverified outcomes;
- redirect targets and page-title changes compared with a prior audit.

For a deep semantic profile, use `ai-profile-brief.md` produced by the audit. It contains a bounded, inspectable evidence set. Have the available AI model produce an `ai-insights.json` with a headline, evidence-backed focus areas, observable information habits, and prioritized maintenance actions; rerun the audit with `--ai-insights`. Keep the report explicit about the difference between command-generated facts and AI interpretation.

Use a prior `audit.json` as `--baseline` to flag a changed redirect target, page title, or availability result. A changed title or redirect is a review signal, not proof that the content is obsolete.
