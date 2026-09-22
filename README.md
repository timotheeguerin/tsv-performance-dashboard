# TSV runtime tracker

A small GitHub Pages dashboard for [TypeSpec Validation - All](https://github.com/Azure/azure-rest-api-specs/actions/workflows/typespec-validation-all.yaml) in Azure/azure-rest-api-specs.

**Live:** https://timotheeguerin.github.io/tsv-performance-dashboard/

The default view contains successful main-branch push runs. Scheduled main and `typespec-next` checkouts are available separately; a failure on one checkout does not change the other checkout's outcome. Pull request runs are excluded.

## Measurements

- **Completion time:** first job start to last job finish for one OS and checkout, including setup and cleanup, excluding queue time.
- **Total validation work:** sum of `Validate All Specs` step durations across that OS's shards. Aggregate execution time, not CPU time or workflow elapsed time.
- **Slowest validation shard:** longest validation step, excluding setup and post-job cleanup.
- **Whole workflow duration:** creation to last update, shown in expanded run details. Includes queue time, all checkouts, and finalization; reruns can span a much longer interval.

Dots represent runs; lines represent UTC daily medians. Incomplete shard sets and missing validation step timestamps produce missing measurements, never artificially fast partial totals. Failed checkouts are excluded by default. The merge comparison uses up to seven successful main pushes immediately before and after the direct-launch merge, within the selected time range; these are observations, not controlled benchmarks.

## Refresh and local use

Requires Node.js 24 or later. The site has no runtime dependencies or build step.

```sh
npm ci
npm test
GITHUB_TOKEN="$(gh auth token)" npm run collect -- --days 30
python3 -m http.server 8000 --directory public
```

Open http://localhost:8000. To run browser checks, install Chromium with `npx playwright install chromium`, then run `npm run test:browser`.

The hourly GitHub Actions workflow refreshes recent runs, commits the JSON history, and deploys `public/` to GitHub Pages. The initial import contains 30 days; historical records are retained. Completed unchanged runs reuse cached job timings. Pending runs continue to be refreshed even if they fall outside the normal two-day lookback.

Run the workflow manually with `backfill_days` to import older history or discover reruns of older completed runs. Only the latest attempt of each run is retained. GitHub's API retention limits how far back timings remain available. GitHub may delay scheduled workflows and disables schedules in public repositories after 60 days without activity.

Collection errors fail the workflow without overwriting the previous dataset. The site flags data older than four hours. No credentials are included in the published site; only public run metadata and timings are collected.
