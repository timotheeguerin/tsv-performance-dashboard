# TSV runtime tracker

Two small GitHub Pages dashboards for TypeSpec validation in Azure/azure-rest-api-specs.

**Live:** https://timotheeguerin.github.io/tsv-performance-dashboard/

- **[TSV-All](https://timotheeguerin.github.io/tsv-performance-dashboard/):** main-branch push runs of `typespec-validation-all.yaml` only. Scheduled runs, PRs, and other branches are excluded.
- **[Regular TSV](https://timotheeguerin.github.io/tsv-performance-dashboard/regular.html):** `typespec-validation.yaml` PR runs with a confirmed `main` target. This workflow runs only on PRs, so the target branch, not the contributor's branch name, determines inclusion.

Both default to successful runs and offer an all-completed-runs filter.

Hover over a chart dot or focus it with the keyboard to see its measured value, UTC run timestamp, outcome, and title. Click the dot to open its GitHub run; press Escape to dismiss the tooltip.

## TSV-All measurements

- **Completion time:** first job start to last job finish for one OS and checkout, including setup and cleanup, excluding queue time.
- **Total validation work:** sum of `Validate All Specs` step durations across that OS's shards. Aggregate execution time, not CPU time or workflow elapsed time.
- **Slowest validation shard:** longest validation step, excluding setup and post-job cleanup.
- **Whole workflow duration:** creation to last update, shown in expanded run details. Includes queue time and finalization; reruns can span a much longer interval.

Dots represent runs. **Trend line** defaults to the original **Daily median**; **Rolling median (7 runs)** is an opt-in, independent of the metric and time range. Rolling lines show a trailing median of up to seven measured runs per OS, with one trend point at every run's actual UTC timestamp. The window restarts at each marked change so pre-merge and post-merge timings are not mixed. Lines step at observed run timestamps rather than interpolating a drop before the first post-change measurement; no measurement is invented at the merge time. Daily lines combine each UTC day's runs into one median plotted at noon, so they can blur intraday changes. The selection is preserved in the URL as `trend=rolling` or `trend=daily`. Summary cards and run dots do not change with line style. Complete historical zero-based shards (`0,1,2`) and current one-based shards (`1,2,3`) are supported. Incomplete, duplicate, or mixed shard sets and missing step timestamps produce missing measurements, never artificially fast partial totals.

Both milestones remain visible together: [Direct CLI launches](https://github.com/Azure/azure-rest-api-specs/pull/46521) (September 22) and [Skip redundant client compilation](https://github.com/Azure/azure-rest-api-specs/pull/46970) (October 2, 15:55:21 UTC). The chart marks every milestone within its date range, and each has its own comparison panel below, newest first. **Total validation work** is selected by default; explicit URL filters still take precedence.

**Completion time** also marks the [checkout-wrapper setup regression](https://github.com/Azure/azure-rest-api-specs/pull/46946) (October 1, 18:40:19 UTC) in red and its [removal](https://github.com/Azure/azure-rest-api-specs/pull/47021) (October 5, 16:19:35 UTC) in green. These annotations use actual merge times and do not add comparison panels or new metrics. They are omitted from validation charts because action initialization is outside validation steps. A fix marker does not imply post-fix runs have completed or been collected yet.

Event labels and UTC merge timestamps appear in a numbered key above the plot, matching numbered dashed markers at the actual dates. The key stacks on narrow screens, and nearby marker badges use separate rows rather than overlapping.

Each comparison calculates medians from up to seven successful main pushes immediately before and after its merge, within the selected time range, and displays the actual sample counts. Panels remain visible when the time filter leaves insufficient data for a comparison. No performance percentages are hard-coded. These are observations, not controlled benchmarks; workload and hosted-runner differences still apply.

## Regular TSV measurements

- **Validation runtime:** only the Linux job's `Validate Impacted Specs` step. Excludes checkout, Node/dependency setup, queue time, and post-job cleanup. Per-project Git cleanup performed inside the validation step remains included.
- **Specs validated:** distinct TypeSpec projects actually entering validation, counted from `Running TypeSpecValidation on folder:` log messages. The `Checking N TypeSpec folders:` header cross-checks the count. Selected but suppressed projects are not counted. This is not a count of emitted Swagger files or compiler invocations.
- **Validation time per spec:** validation step duration divided by validated project count.

Zero-spec runs remain visible in validation runtime and count charts but have no per-spec average. Missing, expired, or unrecognized logs have an explicitly unavailable count, never an assumed zero. Runs with unavailable counts are excluded from averages and count totals; their available validation timings remain visible. Missing validation durations are never replaced with total job time.

Per-spec dots are individual run averages. Daily lines and summary averages divide the sum of validation time by the sum of validated specs across eligible nonzero-spec runs. They are **not** unweighted averages of per-run averages. Runtime/count chart lines use daily medians. The total spec count counts executions across runs, not unique projects in the repository. Raw job/setup timings remain in the downloadable dataset for investigation but are not displayed on the regular dashboard.

PR workloads and tooling revisions differ, so normalized timing is useful context, not a controlled benchmark. Failed runs may validate only part of their selected workload.

## Refresh and local use

Requires Node.js 24 or later. The browser site has no external dependencies. The collector uses `fflate` to read compressed GitHub log archives.

```sh
npm ci
npm test
GITHUB_TOKEN="$(gh auth token)" npm run collect -- --days 30
npm run build
python3 -m http.server 8000 --directory dist
```

Open http://localhost:8000. To run browser checks, install Chromium with `npx playwright install chromium`, then run `npm run test:browser`.

The build copies `public/` to `dist/` and points both HTML pages at a content-versioned directory containing all JavaScript modules and CSS. A script or stylesheet change gets a new asset path, so cached scripts from an older UI are not reused with the new HTML. Imported modules share that revision; dataset refreshes do not change the asset version. Source files remain unchanged. Browser checks exercise this prepared site.

The GitHub Actions workflow is scheduled hourly to refresh both datasets, commit the JSON history, prepare versioned assets, and deploy `dist/` to GitHub Pages. GitHub may delay or skip scheduled starts, so hourly publication is not guaranteed. A newer refresh cancels any older in-progress run, including a deployment stuck waiting for a runner or environment, rather than queuing behind it indefinitely. The previously published site remains available until a deployment succeeds.

The initial import contains 30 days; historical records are retained. Completed unchanged runs reuse cached timings and project counts. Pending runs continue to be refreshed even if they fall outside the normal two-day lookback.

Regular TSV batches job/step metadata through GraphQL and downloads compressed logs only for new or changed runs. Fork runs with empty REST PR associations are resolved by exact fork owner/branch and PR lifetime, with commit associations as a fallback. This also handles old commits made unreachable by force pushes. Ambiguous or unknown targets are excluded and reported, not assumed to target main.

Run the workflow manually with `backfill_days` to import older history or discover reruns of older completed runs. Only the latest attempt of each run is retained. GitHub's API retention limits how far back timings remain available. GitHub may delay scheduled workflows and disables schedules in public repositories after 60 days without activity.

Each dataset is written atomically. Collection errors fail the workflow before committing or publishing refreshed data. Unavailable log counts are retained with an explicit reason. The site flags data older than four hours. No credentials or raw logs are included in the published site; only public run metadata, timings, and project counts are retained.

If the published data is stale, inspect the [refresh workflow](https://github.com/timotheeguerin/tsv-performance-dashboard/actions/workflows/pages.yaml) and manually dispatch a new run. The collector catches up from the last recorded refresh; a normal dispatch does not need a backfill value.
