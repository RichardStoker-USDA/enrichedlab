// Starting points for new apps. The agent scaffolds one with app_create and then edits it like any code; open views
// reload as files change. Templates use only the host's SDK (/app-sdk/lab.js), so nothing needs installing.

export type Template = "data" | "blank" | "shiny" | "shiny-python";

export const TEMPLATES: Template[] = ["data", "blank", "shiny", "shiny-python"];

const STYLE = `:root {
	color-scheme: light dark;
	font-family: var(--font-sans, system-ui, sans-serif);
	color: var(--color-text-primary, CanvasText);
	background: var(--color-background-primary, Canvas);
}
body {
	margin: 0;
	display: grid;
	grid-template-rows: auto 1fr;
	height: 100vh;
}
header {
	display: flex;
	align-items: baseline;
	gap: 12px;
	padding: 12px 16px;
	border-bottom: 1px solid var(--color-border-primary, rgba(128, 128, 128, 0.25));
}
h1 {
	margin: 0;
	font-size: 15px;
	font-weight: var(--font-weight-semibold, 600);
}
.status {
	flex: 1;
	margin: 0;
	font-size: 12.5px;
	color: var(--color-text-secondary, GrayText);
}
main {
	display: grid;
	grid-template-rows: auto 1fr auto;
	min-height: 0;
}
form {
	display: flex;
	flex-wrap: wrap;
	gap: 12px;
	padding: 10px 16px;
	font-size: 13px;
}
label {
	display: flex;
	align-items: center;
	gap: 6px;
	color: var(--color-text-secondary, GrayText);
}
input,
select {
	font: inherit;
	color: inherit;
	padding: 4px 8px;
	border-radius: var(--border-radius-sm, 6px);
	border: 1px solid var(--color-border-primary, rgba(128, 128, 128, 0.35));
	background: var(--color-background-secondary, transparent);
}
.plot {
	min-height: 240px;
	margin: 0 8px;
}
.summary {
	margin: 0;
	padding: 10px 16px 14px;
	font: 12px/1.5 var(--font-mono, ui-monospace, monospace);
	color: var(--color-text-secondary, GrayText);
	white-space: pre-wrap;
}
`;

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${title}</title>
		<link rel="stylesheet" href="style.css" />
	</head>
	<body>
${body}
		<script type="module" src="main.js"></script>
	</body>
</html>
`;
}

const DATA_MAIN = `// Reads a table from the session's project, draws two numeric columns on the GPU, and asks the backend for a
// summary. Edit freely: the view reloads as you save.
import { connect, scatter } from "/app-sdk/lab.js";

const lab = await connect({ name: "__NAME__", version: "0.1.0" });
const $ = (id) => document.getElementById(id);
const status = (text) => ($("status").textContent = text);

let table;
let plot;

async function load() {
	const path = $("path").value.trim();
	status(\`Reading \${path}…\`);
	try {
		table = await lab.table(path);
	} catch (error) {
		return status(error.message);
	}
	const numeric = table.columns.filter((c) => c.type === "number").map((c) => c.name);
	for (const select of [$("x"), $("y")]) select.replaceChildren(...numeric.map((name) => new Option(name, name)));
	$("color").replaceChildren(new Option("none", ""), ...table.columns.map((c) => new Option(c.name, c.name)));
	if (numeric[1]) $("y").value = numeric[1];
	await lab.store.set("path", path);
	await draw();
}

async function draw() {
	const column = (name) => table.columns.find((c) => c.name === name);
	const x = column($("x").value);
	const y = column($("y").value);
	if (!x || !y) return status("Pick two numeric columns.");
	const keep = [];
	for (let i = 0; i < table.rows; i++) if (typeof x.values[i] === "number" && typeof y.values[i] === "number") keep.push(i);
	const color = column($("color").value);
	const options = {
		x: keep.map((i) => x.values[i]),
		y: keep.map((i) => y.values[i]),
		color: color ? keep.map((i) => color.values[i]) : undefined,
		xLabel: x.name,
		yLabel: y.name,
	};
	if (plot) plot.update(options);
	else plot = await scatter($("plot"), options);
	status(\`\${keep.length.toLocaleString()} points · \${plot.backend}\`);
	const summary = await lab.call("summarize", { values: keep.map((i) => y.values[i]) });
	$("summary").textContent = \`\${y.name}: mean \${summary.mean.toPrecision(4)}, sd \${summary.sd.toPrecision(4)}, n \${summary.n}\`;
	await lab.share(\`The app plots \${y.name} against \${x.name} for \${keep.length} rows of \${$("path").value}. \${$("summary").textContent}\`);
}

$("path").addEventListener("change", load);
for (const id of ["x", "y", "color"]) $(id).addEventListener("change", draw);
$("path").value = (await lab.store.get("path")) ?? "data.csv";
await load();
`;

const DATA_BACKEND = `// The app's backend: tools on the Bun runtime inside EnrichedLab, contained by the OS sandbox. The page calls them
// with lab.call(name, args); the agent can call them too.

export const tools = {
	summarize: {
		description: "Mean, standard deviation and count of a list of numbers",
		input: { type: "object", properties: { values: { type: "array", items: { type: "number" } } }, required: ["values"] },
		annotations: { readOnlyHint: true },
		run({ values }) {
			const n = values.length;
			const mean = n ? values.reduce((a, b) => a + b, 0) / n : 0;
			const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
			return { text: \`mean \${mean}, sd \${sd}, n \${n}\`, data: { mean, sd, n } };
		},
	},
};
`;

const BLANK_MAIN = `import { connect } from "/app-sdk/lab.js";

const lab = await connect({ name: "__NAME__", version: "0.1.0" });
const session = await lab.session();
document.getElementById("status").textContent = \`Connected · \${session.project}\`;
`;

const SHINY_APP = `library(shiny)

ui <- fluidPage(
  titlePanel("__TITLE__"),
  sidebarLayout(
    sidebarPanel(sliderInput("n", "Points", min = 10, max = 5000, value = 500)),
    mainPanel(plotOutput("scatter"))
  )
)

server <- function(input, output) {
  output$scatter <- renderPlot({
    x <- rnorm(input$n)
    plot(x, x + rnorm(input$n, sd = 0.4), pch = 19, col = "#008EAA80", xlab = "x", ylab = "y")
  })
}

shinyApp(ui, server)
`;

const PY_SHINY_APP = `from shiny import App, render, ui
import matplotlib.pyplot as plt
import numpy as np

app_ui = ui.page_fluid(
    ui.h2("__TITLE__"),
    ui.input_slider("n", "Points", min=10, max=5000, value=500),
    ui.output_plot("scatter"),
)


def server(input, output, session):
    @render.plot
    def scatter():
        x = np.random.normal(size=input.n())
        fig, ax = plt.subplots()
        ax.scatter(x, x + np.random.normal(scale=0.4, size=input.n()), s=8, alpha=0.5, color="#008EAA")
        ax.set_xlabel("x")
        ax.set_ylabel("y")
        return fig


app = App(app_ui, server)
`;

/** A pixi environment: the packages an app needs, from conda-forge, the same on every operating system. */
function environment(name: string, deps: Record<string, string>): string {
	return `[workspace]
name = "${name}"
channels = ["conda-forge"]
platforms = ["osx-arm64", "osx-64", "linux-64", "linux-aarch64", "win-64"]

[dependencies]
${Object.entries(deps)
	.map(([k, v]) => `${k} = "${v}"`)
	.join("\n")}
`;
}

/** The files of a new app, by path. */
export function templateFiles(template: Template, name: string, title: string, description: string): Record<string, string> {
	const fill = (text: string) => text.replaceAll("__NAME__", name).replaceAll("__TITLE__", title);
	const manifest = (extra: Record<string, unknown>) => `${JSON.stringify({ name, title, version: "0.1.0", description, ...extra }, null, 2)}\n`;
	const header = `		<header><h1>${title}</h1><p class="status" id="status">Connecting…</p></header>`;
	switch (template) {
		case "blank":
			return { "app.json": manifest({ entry: "index.html" }), "index.html": page(title, header), "main.js": fill(BLANK_MAIN), "style.css": STYLE };
		case "shiny":
			return {
				"app.json": manifest({ backend: { runtime: "serve", command: ["Rscript", "-e", "shiny::runApp('app.R', port = as.integer(Sys.getenv('PORT')), host = '127.0.0.1', launch.browser = FALSE)"] } }),
				"app.R": fill(SHINY_APP),
				"pixi.toml": environment(name, { "r-base": "4.5.*", "r-shiny": "*" }),
			};
		case "shiny-python":
			return {
				"app.json": manifest({ backend: { runtime: "serve", command: ["shiny", "run", "app.py", "--host", "127.0.0.1", "--port", "$PORT"] } }),
				"app.py": fill(PY_SHINY_APP),
				"pixi.toml": environment(name, { python: "3.13.*", shiny: "*", matplotlib: "*", numpy: "*" }),
			};
		case "data":
			return {
				"app.json": manifest({ entry: "index.html", backend: { runtime: "bun", main: "backend.js" }, permissions: { files: "read" } }),
				"index.html": page(
					title,
					`${header}
		<main>
			<form id="pick">
				<label>File <input id="path" size="24" spellcheck="false" /></label>
				<label>x <select id="x"></select></label>
				<label>y <select id="y"></select></label>
				<label>Color <select id="color"></select></label>
			</form>
			<div class="plot" id="plot"></div>
			<p class="summary" id="summary"></p>
		</main>`,
				),
				"main.js": fill(DATA_MAIN),
				"backend.js": DATA_BACKEND,
				"style.css": STYLE,
			};
	}
}
