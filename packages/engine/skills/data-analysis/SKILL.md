---
name: data-analysis
description: Analyze scientific data reproducibly in R or Python: read and check the data, clean it in a script, run the statistics or models the question needs, and show the tables and figures in the workbench. Use for any analysis, summary statistics, regression, mixed models, machine learning, or comparison of treatments on CSV, Excel, Parquet or database data.
---

# Reproducible analysis

## Steps

1. **Understand the data.** Print shape, columns, types, units, missing values, duplicates and a few rows. Ask about
   anything ambiguous that changes the answer (units, the experimental unit, which rows are controls).
2. **One script per analysis**, rerunnable from scratch: `analysis/01_clean.R`, `02_model.R` (or `.py`). Read inputs
   by relative path, write outputs to `outputs/` (never over source data), set seeds, and print the versions of the
   packages used.
3. **Environment.** Use the project's environment when it has one (`renv.lock`, `pixi.toml`, `pyproject.toml`). In a
   new Python project create one with pixi; in R use renv. Don't install into the system.
4. **Statistics.** Say which test or model and why, check its assumptions (residual plots, overdispersion, random
   effect structure for repeated measures), report estimates with confidence intervals and effect sizes, not only p
   values, and correct for multiple comparisons when there are many.
5. **Show it.** Write result tables as CSV and figures as PNG or SVG in `outputs/`, then open them with `show` so they
   appear in the workbench. For figures the person will refine, offer a Shiny app (skill `shiny-figures`).
6. **Report** what was done, the numbers that answer the question, caveats, and the files written.

## Where it runs

Large or protected data stays where it is: in a lab session, run the scripts in the lab sandbox and bring back only
results. On this computer, keep work inside the project folder.
