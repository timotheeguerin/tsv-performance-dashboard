# TSV runtime tracker

Two small GitHub Pages dashboards for TypeSpec validation in Azure/azure-rest-api-specs.

**Live:** https://timotheeguerin.github.io/tsv-performance-dashboard/

- **[TSV-All](https://timotheeguerin.github.io/tsv-performance-dashboard/):** main-branch push runs of `typespec-validation-all.yaml` only. Scheduled runs, PRs, and other branches are excluded.
- **[Regular TSV](https://timotheeguerin.github.io/tsv-performance-dashboard/regular.html):** `typespec-validation.yaml` PR runs with a confirmed `main` target. This workflow runs only on PRs, so the target branch, not the contributor's branch name, determines inclusion.

Both default to successful runs and offer an all-completed-runs filter.

## TSV-All measurements

- **Completion time:** first job start to last job finish for one OS and checkout, including setup and cleanup, excluding queue time.
- **Total validation work:** sum of `Validate All Specs` step durations across that OS's shards. Aggregate execution time, not CPU time or workflow elapsed time.
- **Slowest validation shard:** longest validation step, excluding setup and post-job cleanup.
- **Whole workflow duration:** creation to last update, shown in expanded run details. Includes queue time and finalization; reruns can span a much longer interval.

Dots represent runs; lines represent UTC daily medians. Incomplete shard sets and missing step timestamps produce missing measurements, never artificially fast partial totals. The merge comparison uses up to seven successful main pushes immediately before and after the direct-launch merge, within the selected time range; these are observations, not controlled benchmarks.

## Regular TSV measurements

- **Validation runtime:** only the Linux job's `Validate Impacted Specs` step. Excludes checkout, Node/dependency setup, queue time, and post-job cleanup. Per-project Git cleanup performed inside the validation step remains included.
- **Specs validated:** distinct TypeSpec projects actually entering validation, counted from `Running TypeSpecValidation on folder:` log messages. The `Checking N TypeSpec folders:` header cross-checks the count. Selected but suppressed projects are not counted. This is not a count of emitted Swagger files or compiler invocations.
- **Validation time per spec:** validation step duration divided by validated project count.

Zero-spec runs remain visible in validation runtime and count charts but have no per-spec average. Missing, expired, or unrecognized logs have an explicitly unavailable count, never an assumed zero. Runs with unavailable counts are excluded from averages and count totals; their available validation timings remain visible. Missing validation durations are never replaced with total job time.

Per-spec dots are individual run averages. Daily lines and summary averages divide the sum of validation time by the sum of validated specs across eligible nonzero-spec runs. They are **not** unweighted averages of per-run averages. Runtime/count chart lines use daily medians. The total spec count counts executions across runs, not unique projects in the repository. Raw job/setup timings remain in the downloadable dataset for investigation but are not displayed on the regular dashboard.

PR workloads and tooling revisions differ, so normalized timing is useful context, not a controlled benchmark. Failed runs may validate only part of their selected workload.

## Refresh and local use

Requires Node.js 24 or later. The browser site has no external dependencies or build step. The collector uses `fflate` to read compressed GitHub log archives.

```sh
npm ci
npm test
GITHUB_TOKEN="$(gh auth token)" npm run collect -- --days 30
python3 -m http.server 8000 --directory public
```

Open http://localhost:8000. To run browser checks, install Chromium with `npx playwright install chromium`, then run `npm run test:browser`.

The hourly GitHub Actions workflow refreshes both datasets, commits the JSON history, and deploys `public/` to GitHub Pages. The initial import contains 30 days; historical records are retained. Completed unchanged runs reuse cached timings and project counts. Pending runs continue to be refreshed even if they fall outside the normal two-day lookback.

Regular TSV batches job/step metadata through GraphQL and downloads compressed logs only for new or changed runs. Fork runs with empty REST PR associations are resolved by exact fork owner/branch and PR lifetime, with commit associations as a fallback. This also handles old commits made unreachable by force pushes. Ambiguous or unknown targets are excluded and reported, not assumed to target main.

Run the workflow manually with `backfill_days` to import older history or discover reruns of older completed runs. Only the latest attempt of each run is retained. GitHub's API retention limits how far back timings remain available. GitHub may delay scheduled workflows and disables schedules in public repositories after 60 days without activity.

Each dataset is written atomically. Collection errors fail the workflow before committing or publishing refreshed data. Unavailable log counts are retained with an explicit reason. The site flags data older than four hours. No credentials or raw logs are included in the published site; only public run metadata, timings, and project counts are retained.
