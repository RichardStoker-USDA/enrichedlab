---
name: shiny-figures
description: Build an interactive Shiny app (R or Python) that shows the person's data as publication figures they can adjust and export: title, axis labels, legend, colors, plot type, line and point styles, size and resolution, saved as PDF, SVG, PNG or TIFF. Use when someone wants to explore data visually, make or tweak a figure for a paper or poster, or keep a dashboard.
---

# Shiny apps for figures

The app runs where the session works (this computer, or the lab sandbox when the data is there) and opens in the
workbench. Build it so the person can make the figure they want without asking you again.

## Build

1. Read the data first: columns, types, units, missing values, a few rows. Pick a sensible first figure.
2. One folder per app, such as `apps/yield_figures/`, with `app.R` (or `app.py`) and a short `README.md` saying how to
   run it. Read data from the project by relative path; never copy lab data out of the sandbox.
3. Controls in a sidebar, figure in the main panel:
   - data: x, y, color/group, facet columns chosen from the data's own columns; filters for the main factors;
   - type: points, lines, points and lines, bars, box, violin, histogram, density, heatmap where the data fits;
   - labels: title, subtitle, x and y labels (prefilled with column names and units), legend title and position;
   - look: palette (colorblind-safe first: viridis, Okabe-Ito), point size, line width, theme (classic, minimal,
     black and white), base font size, aspect ratio;
   - statistics: smoother or regression line with its band, error bars from replicates when the data has them.
4. Export: width and height in inches or millimeters, DPI (300 default, 600 for print), and buttons for PDF, SVG,
   PNG and TIFF (R: `ggsave` with `device`; Python: Plotly `write_image` with Kaleido, or Matplotlib `savefig`). Name
   files from the title. Keep the exported figure identical to the one on screen.
5. Also export the figure's settings as a small JSON or R script, so the same figure can be rebuilt.

## Run and check

- R: `shiny::runApp("apps/yield_figures", port = <free port>, launch.browser = FALSE)`; Python: `shiny run`.
  Start it with the tool that serves apps in this place, then open it in the workbench.
- Click through every control once; export each format once and open the files to check size, fonts and colors.
- Report the app's folder, how to start it again, and what each control does in one line each.
