// Points and lines for the plot pane. WebGPU draws every point as an instanced disc, so a million points pan and zoom
// at frame rate; Canvas 2D draws the same picture where WebGPU isn't available. Axes and labels are drawn by the pane
// on its own overlay; this file only maps data to pixels and pixels back to data.

export interface PlotData {
	x: Float32Array;
	y: Float32Array;
	/** One color per point, RGBA 0 to 1, packed. */
	color: Float32Array;
	line: boolean;
}

export interface View {
	/** Data range shown. */
	x0: number;
	x1: number;
	y0: number;
	y1: number;
}

/** Categorical colors from the UC Davis secondary palette, distinct in both themes. */
export const CATEGORY = ["#008EAA", "#F18A00", "#3DAE2B", "#C10230", "#0047BA", "#FFBF00", "#76236C", "#8A532F", "#6CCA98", "#F095CD"];

/** viridis, sampled: perceptually even and readable by people with color-vision deficiency. */
const VIRIDIS = ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"];

export function hex(color: string): [number, number, number] {
	const n = Number.parseInt(color.slice(1), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function ramp(t: number): [number, number, number] {
	const p = Math.min(1, Math.max(0, t)) * (VIRIDIS.length - 1);
	const i = Math.floor(p);
	const a = hex(VIRIDIS[i]!);
	const b = hex(VIRIDIS[Math.min(i + 1, VIRIDIS.length - 1)]!);
	const f = p - i;
	return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const SHADER = /* wgsl */ `
struct U { view: vec4f, size: vec2f, point: f32, pad: f32 };
@group(0) @binding(0) var<uniform> u: U;
struct Out { @builtin(position) pos: vec4f, @location(0) color: vec4f, @location(1) corner: vec2f };
fn clip(p: vec2f) -> vec2f {
  return vec2f((p.x - u.view.x) / (u.view.y - u.view.x) * 2.0 - 1.0, (p.y - u.view.z) / (u.view.w - u.view.z) * 2.0 - 1.0);
}
@vertex fn points(@builtin(vertex_index) v: u32, @location(0) p: vec2f, @location(1) c: vec4f) -> Out {
  var corners = array<vec2f, 6>(vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1), vec2f(-1,1), vec2f(1,-1), vec2f(1,1));
  let k = corners[v];
  var o: Out;
  o.pos = vec4f(clip(p) + k * u.point / u.size, 0.0, 1.0);
  o.color = c;
  o.corner = k;
  return o;
}
@vertex fn lines(@location(0) p: vec2f, @location(1) c: vec4f) -> Out {
  var o: Out;
  o.pos = vec4f(clip(p), 0.0, 1.0);
  o.color = c;
  o.corner = vec2f(0.0);
  return o;
}
@fragment fn disc(i: Out) -> @location(0) vec4f {
  let d = length(i.corner);
  let a = 1.0 - smoothstep(0.75, 1.0, d);
  if (a <= 0.0) { discard; }
  return vec4f(i.color.rgb * i.color.a * a, i.color.a * a);
}
@fragment fn solid(i: Out) -> @location(0) vec4f {
  return vec4f(i.color.rgb * i.color.a, i.color.a);
}`;

export interface Renderer {
	readonly backend: "WebGPU" | "Canvas 2D";
	setData(data: PlotData): void;
	draw(view: View, pointSize: number): void;
	resize(width: number, height: number, dpr: number): void;
	destroy(): void;
}

export async function createRenderer(canvas: HTMLCanvasElement): Promise<Renderer> {
	const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
	if (gpu) {
		try {
			const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
			if (adapter) return await webgpu(canvas, gpu, await adapter.requestDevice());
		} catch {
			// Fall through to Canvas 2D.
		}
	}
	return canvas2d(canvas);
}

async function webgpu(canvas: HTMLCanvasElement, gpu: GPU, device: GPUDevice): Promise<Renderer> {
	const context = canvas.getContext("webgpu")!;
	const format = gpu.getPreferredCanvasFormat();
	context.configure({ device, format, alphaMode: "premultiplied" });
	const module = device.createShaderModule({ code: SHADER });
	const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }] });
	const bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
	const blend: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
	const pipeline = (vertex: string, fragment: string, topology: GPUPrimitiveTopology, stepMode: GPUVertexStepMode) =>
		device.createRenderPipeline({
			layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
			vertex: {
				module,
				entryPoint: vertex,
				buffers: [
					{ arrayStride: 8, stepMode, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
					{ arrayStride: 16, stepMode, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x4" }] },
				],
			},
			fragment: { module, entryPoint: fragment, targets: [{ format, blend }] },
			primitive: { topology },
		});
	const pointsPipe = pipeline("points", "disc", "triangle-list", "instance");
	const linesPipe = pipeline("lines", "solid", "line-strip", "vertex");
	let positions: GPUBuffer | undefined;
	let colors: GPUBuffer | undefined;
	let count = 0;
	let line = false;
	let size = [1, 1];
	return {
		backend: "WebGPU",
		setData(data) {
			positions?.destroy();
			colors?.destroy();
			count = data.x.length;
			line = data.line;
			const xy = new Float32Array(count * 2);
			for (let i = 0; i < count; i++) {
				xy[i * 2] = data.x[i]!;
				xy[i * 2 + 1] = data.y[i]!;
			}
			positions = device.createBuffer({ size: Math.max(8, xy.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
			colors = device.createBuffer({ size: Math.max(16, data.color.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
			device.queue.writeBuffer(positions, 0, xy);
			device.queue.writeBuffer(colors, 0, data.color);
		},
		draw(view, pointSize) {
			if (!positions || !colors) return;
			device.queue.writeBuffer(uniform, 0, new Float32Array([view.x0, view.x1, view.y0, view.y1, size[0]!, size[1]!, pointSize, 0]));
			const encoder = device.createCommandEncoder();
			const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
			pass.setBindGroup(0, bind);
			pass.setVertexBuffer(0, positions);
			pass.setVertexBuffer(1, colors);
			if (line) {
				pass.setPipeline(linesPipe);
				pass.draw(count);
			} else {
				pass.setPipeline(pointsPipe);
				pass.draw(6, count);
			}
			pass.end();
			device.queue.submit([encoder.finish()]);
		},
		resize(width, height, dpr) {
			canvas.width = Math.max(1, Math.round(width * dpr));
			canvas.height = Math.max(1, Math.round(height * dpr));
			size = [width, height];
		},
		destroy() {
			positions?.destroy();
			colors?.destroy();
			uniform.destroy();
			device.destroy();
		},
	};
}

function canvas2d(canvas: HTMLCanvasElement): Renderer {
	const ctx = canvas.getContext("2d")!;
	let data: PlotData | undefined;
	let dpr = 1;
	return {
		backend: "Canvas 2D",
		setData(next) {
			data = next;
		},
		draw(view, pointSize) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			if (!data) return;
			const w = canvas.width;
			const h = canvas.height;
			const sx = w / (view.x1 - view.x0);
			const sy = h / (view.y1 - view.y0);
			const r = Math.max(1, pointSize * dpr);
			const css = (i: number) => `rgba(${Math.round(data!.color[i * 4]! * 255)},${Math.round(data!.color[i * 4 + 1]! * 255)},${Math.round(data!.color[i * 4 + 2]! * 255)},${data!.color[i * 4 + 3]})`;
			if (data.line) {
				ctx.lineWidth = dpr;
				ctx.strokeStyle = css(0);
				ctx.beginPath();
				for (let i = 0; i < data.x.length; i++) {
					const px = (data.x[i]! - view.x0) * sx;
					const py = h - (data.y[i]! - view.y0) * sy;
					if (i) ctx.lineTo(px, py);
					else ctx.moveTo(px, py);
				}
				ctx.stroke();
				return;
			}
			for (let i = 0; i < data.x.length; i++) {
				const px = (data.x[i]! - view.x0) * sx;
				const py = h - (data.y[i]! - view.y0) * sy;
				if (px < -r || py < -r || px > w + r || py > h + r) continue;
				ctx.fillStyle = css(i);
				ctx.fillRect(px - r / 2, py - r / 2, r, r);
			}
		},
		resize(width, height, ratio) {
			dpr = ratio;
			canvas.width = Math.max(1, Math.round(width * ratio));
			canvas.height = Math.max(1, Math.round(height * ratio));
		},
		destroy() {},
	};
}

/** Round tick values for an axis: about `target` steps at 1, 2 or 5 times a power of ten. */
export function ticks(lo: number, hi: number, target = 6): number[] {
	const span = hi - lo;
	if (!(span > 0) || !Number.isFinite(span)) return [lo];
	const raw = span / target;
	const power = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 5, 10].map((m) => m * power).find((s) => span / s <= target) ?? 10 * power;
	const out: number[] = [];
	for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
	return out;
}

/** The nearest point to a data position within `radius` (in data units per axis), using a bucket grid. */
export class NearestIndex {
	private cells = new Map<string, number[]>();
	private cw: number;
	private ch: number;

	constructor(
		private x: Float32Array,
		private y: Float32Array,
		view: View,
	) {
		this.cw = (view.x1 - view.x0) / 64 || 1;
		this.ch = (view.y1 - view.y0) / 64 || 1;
		for (let i = 0; i < x.length; i++) {
			const key = `${Math.floor(x[i]! / this.cw)},${Math.floor(y[i]! / this.ch)}`;
			let cell = this.cells.get(key);
			if (!cell) this.cells.set(key, (cell = []));
			cell.push(i);
		}
	}

	find(px: number, py: number, rx: number, ry: number): number | undefined {
		const cx = Math.floor(px / this.cw);
		const cy = Math.floor(py / this.ch);
		const reach = Math.max(1, Math.ceil(Math.max(rx / this.cw, ry / this.ch)));
		let best: number | undefined;
		let bestD = Infinity;
		for (let i = cx - reach; i <= cx + reach; i++) {
			for (let j = cy - reach; j <= cy + reach; j++) {
				for (const k of this.cells.get(`${i},${j}`) ?? []) {
					const dx = (this.x[k]! - px) / rx;
					const dy = (this.y[k]! - py) / ry;
					const d = dx * dx + dy * dy;
					if (d < bestD && d <= 1) {
						bestD = d;
						best = k;
					}
				}
			}
		}
		return best;
	}
}
