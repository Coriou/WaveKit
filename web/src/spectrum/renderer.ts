/**
 * WebGL2 renderer for the spectrum trace (top band) and waterfall (bottom band), one full-screen pass.
 * Shared by the OffscreenCanvas worker path and the main-thread fallback: it only needs a
 * WebGL2RenderingContext. The waterfall is an R8 texture used as a ring (one texSubImage2D per row);
 * levels, view mapping and ring position are uniforms, so a view or level change re-uploads nothing.
 */

import { RAMP_SIZE } from "./ramp.ts"
import { MAX_TAPS } from "./view.ts"

export interface DrawParams {
	/** u(x) = offset + x · scale; bins outside 0–limit are empty. */
	map: { offset: number; scale: number; limit: number }
	/** colour position t = sample · scale + offset (sample = byte / 255). */
	level: { scale: number; offset: number }
	/** Ring index of the newest row. */
	newest: number
	/** Rows held. */
	filled: number
	/** Rows over the waterfall band's height. */
	rows: number
	/** Trace band height, device px (0 hides it). */
	tracePx: number
	/** Empty band between the trace and the waterfall, device px. */
	gapPx: number
	/** Line half-width, device px. */
	lineHalfWidth: number
	peakHold: boolean
}

/** What SpectrumScene needs from a renderer (a fake in unit tests). */
export interface SceneRenderer {
	resize(widthPx: number, heightPx: number): void
	uploadRow(index: number, row: Uint8Array, count: number): void
	uploadPeak(row: Uint8Array, count: number): void
	setRamp(rgba: Uint8Array): void
	draw(params: DrawParams): void
	dispose(): void
}

const VERTEX = `#version 300 es
precision highp float;
void main() {
	// Full-screen triangle from gl_VertexID: (-1,-1), (3,-1), (-1,3).
	vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
	gl_Position = vec4(p, 0.0, 1.0);
}
`

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_wf;
uniform sampler2D u_peak;
uniform sampler2D u_ramp;
uniform vec2 u_size;      // canvas, device px
uniform float u_tracePx;  // trace band height from the top, device px
uniform vec3 u_map;       // texture u = x * scale + offset; limit
uniform vec2 u_level;     // t = sample * scale + offset
uniform float u_texWidth;
uniform float u_depth;    // ring rows
uniform float u_newest;   // ring index of the newest row
uniform float u_filled;
uniform float u_rows;     // rows over the waterfall band
uniform float u_lineHalf;
uniform float u_peakOn;
uniform float u_gapPx;   // empty band between the trace and the waterfall, device px

const int MAX_TAPS = ${MAX_TAPS};

out vec4 outColor;

vec4 ramp(float t) {
	return texture(u_ramp, vec2(clamp(t, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
}

float texU(float px) {
	return u_map.y + (px / u_size.x) * u_map.x;
}

bool inCapture(float u) {
	return u >= 0.0 && u <= u_map.z;
}

// Keep LINEAR filtering away from stale texels past the row's last bin.
float clampU(float u) {
	return clamp(u, 0.5 / u_texWidth, u_map.z - 0.5 / u_texWidth);
}

float rowIndex(float age) {
	return mod(u_newest - age + u_depth, u_depth);
}

float level(float s) {
	return s * u_level.x + u_level.y;
}

// Sample of the bins under screen px [a, b] in texture row \`row\` (v its normalized centre). Zoomed in
// (at most one bin per px) it is the LINEAR sample at the middle; zoomed out it is the MAX over the
// covered bins, so a narrow signal never falls between pixels. At most MAX_TAPS fetches: wider spans
// are strided (view.ts coveredBins mirrors this).
float sampleSpan(sampler2D tex, int row, float v, float a, float b) {
	float t0 = texU(a) * u_texWidth;
	float t1 = texU(b) * u_texWidth;
	if (t1 - t0 <= 1.0) return texture(tex, vec2(clampU(texU(0.5 * (a + b))), v)).r;
	float last = u_map.z * u_texWidth - 1.0;
	int i0 = int(clamp(floor(t0), 0.0, last));
	int i1 = int(clamp(ceil(t1) - 1.0, 0.0, last));
	int stride = (i1 - i0 + MAX_TAPS) / MAX_TAPS;
	float m = 0.0;
	for (int k = 0; k < MAX_TAPS; k++) {
		int i = i0 + k * stride;
		if (i > i1) break;
		m = max(m, texelFetch(tex, ivec2(i, row), 0).r);
	}
	return m;
}

// y of a sample on the trace, device px from the top of the trace band.
float traceY(float s) {
	float t = clamp(level(s), 0.0, 1.0);
	float top = 2.0 * u_lineHalf;
	return top + (1.0 - t) * (u_tracePx - top - 1.0);
}

// Coverage of a vertical stroke through the trace at px: spans the pixel's own level and the levels
// half a pixel either side, so steep slopes stay connected.
float stroke(sampler2D tex, int row, float v, float px, float y, float yc, float halfWidth) {
	float y0 = traceY(sampleSpan(tex, row, v, px - 1.0, px));
	float y1 = traceY(sampleSpan(tex, row, v, px, px + 1.0));
	float lo = min(min(y0, y1), yc) - halfWidth;
	float hi = max(max(y0, y1), yc) + halfWidth;
	return clamp(min(y - lo, hi - y) + 0.5, 0.0, 1.0);
}

void main() {
	float px = gl_FragCoord.x;
	float y = u_size.y - gl_FragCoord.y; // device px from the top
	vec4 bg = ramp(0.0);
	float u = texU(px);
	bool hasData = u_filled > 0.5 && inCapture(u);
	float wfTop = u_tracePx + u_gapPx;

	if (y >= u_tracePx) {
		if (y < wfTop) {
			// Gap between the bands (the DOM axis sits there).
			outColor = vec4(bg.rgb, 1.0);
			return;
		}
		// Waterfall: newest row at the top of the band.
		float wy = (y - wfTop) / max(u_size.y - wfTop, 1.0);
		float age = floor(wy * u_rows);
		if (!hasData || age >= u_filled) {
			outColor = bg;
			return;
		}
		float index = rowIndex(age);
		float s = sampleSpan(u_wf, int(index), (index + 0.5) / u_depth, px - 0.5, px + 0.5);
		outColor = vec4(ramp(level(s)).rgb, 1.0);
		return;
	}

	vec3 color = bg.rgb;
	if (hasData) {
		float index = rowIndex(0.0);
		int row = int(index);
		float v = (index + 0.5) / u_depth;
		float yc = traceY(sampleSpan(u_wf, row, v, px - 0.5, px + 0.5));
		vec4 lineColor = ramp(0.82);
		if (y > yc) {
			float depth = (y - yc) / max(u_tracePx - yc, 1.0);
			color = mix(color, lineColor.rgb, mix(0.32, 0.04, depth));
		}
		if (u_peakOn > 0.5) {
			float pc = traceY(sampleSpan(u_peak, 0, 0.5, px - 0.5, px + 0.5));
			float p = stroke(u_peak, 0, 0.5, px, y, pc, u_lineHalf * 0.6);
			color = mix(color, ramp(1.0).rgb, 0.55 * p);
		}
		float c = stroke(u_wf, row, v, px, y, yc, u_lineHalf);
		color = mix(color, lineColor.rgb, c);
	}
	outColor = vec4(color, 1.0);
}
`

type Uniforms = Record<
	| "u_wf"
	| "u_peak"
	| "u_ramp"
	| "u_size"
	| "u_tracePx"
	| "u_map"
	| "u_level"
	| "u_texWidth"
	| "u_depth"
	| "u_newest"
	| "u_filled"
	| "u_rows"
	| "u_lineHalf"
	| "u_peakOn"
	| "u_gapPx",
	WebGLUniformLocation | null
>

export class SpectrumRenderer implements SceneRenderer {
	private readonly gl: WebGL2RenderingContext
	private readonly program: WebGLProgram
	private readonly vao: WebGLVertexArrayObject
	private readonly wf: WebGLTexture
	private readonly peak: WebGLTexture
	private readonly ramp: WebGLTexture
	private readonly u: Uniforms
	private readonly texWidth: number
	private readonly depth: number

	constructor(gl: WebGL2RenderingContext, texWidth: number, depth: number) {
		this.gl = gl
		this.texWidth = texWidth
		this.depth = depth
		this.program = link(gl, VERTEX, FRAGMENT)
		this.vao = must(gl.createVertexArray(), "vertex array")
		this.wf = texture(gl, gl.R8, texWidth, depth)
		this.peak = texture(gl, gl.R8, texWidth, 1)
		this.ramp = texture(gl, gl.RGBA8, RAMP_SIZE, 1)
		const names = [
			"u_wf",
			"u_peak",
			"u_ramp",
			"u_size",
			"u_tracePx",
			"u_map",
			"u_level",
			"u_texWidth",
			"u_depth",
			"u_newest",
			"u_filled",
			"u_rows",
			"u_lineHalf",
			"u_peakOn",
			"u_gapPx",
		] as const
		this.u = Object.fromEntries(
			names.map(n => [n, gl.getUniformLocation(this.program, n)]),
		) as Uniforms
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
		gl.disable(gl.DEPTH_TEST)
		gl.disable(gl.BLEND)
	}

	resize(widthPx: number, heightPx: number): void {
		const canvas = this.gl.canvas
		if (canvas.width !== widthPx) canvas.width = widthPx
		if (canvas.height !== heightPx) canvas.height = heightPx
	}

	uploadRow(index: number, row: Uint8Array, count: number): void {
		const gl = this.gl
		const n = Math.min(count, this.texWidth, row.length)
		if (n <= 0 || index < 0 || index >= this.depth) return
		gl.bindTexture(gl.TEXTURE_2D, this.wf)
		gl.texSubImage2D(
			gl.TEXTURE_2D,
			0,
			0,
			index,
			n,
			1,
			gl.RED,
			gl.UNSIGNED_BYTE,
			row,
		)
	}

	uploadPeak(row: Uint8Array, count: number): void {
		const gl = this.gl
		const n = Math.min(count, this.texWidth, row.length)
		if (n <= 0) return
		gl.bindTexture(gl.TEXTURE_2D, this.peak)
		gl.texSubImage2D(
			gl.TEXTURE_2D,
			0,
			0,
			0,
			n,
			1,
			gl.RED,
			gl.UNSIGNED_BYTE,
			row,
		)
	}

	setRamp(rgba: Uint8Array): void {
		if (rgba.length < RAMP_SIZE * 4) return
		const gl = this.gl
		gl.bindTexture(gl.TEXTURE_2D, this.ramp)
		gl.texSubImage2D(
			gl.TEXTURE_2D,
			0,
			0,
			0,
			RAMP_SIZE,
			1,
			gl.RGBA,
			gl.UNSIGNED_BYTE,
			rgba,
		)
	}

	draw(p: DrawParams): void {
		const gl = this.gl
		const w = gl.drawingBufferWidth
		const h = gl.drawingBufferHeight
		gl.viewport(0, 0, w, h)
		gl.useProgram(this.program)
		gl.bindVertexArray(this.vao)
		bindUnit(gl, 0, this.wf, this.u.u_wf)
		bindUnit(gl, 1, this.peak, this.u.u_peak)
		bindUnit(gl, 2, this.ramp, this.u.u_ramp)
		gl.uniform2f(this.u.u_size, w, h)
		gl.uniform1f(this.u.u_tracePx, p.tracePx)
		gl.uniform3f(this.u.u_map, p.map.scale, p.map.offset, p.map.limit)
		gl.uniform2f(this.u.u_level, p.level.scale, p.level.offset)
		gl.uniform1f(this.u.u_texWidth, this.texWidth)
		gl.uniform1f(this.u.u_depth, this.depth)
		gl.uniform1f(this.u.u_newest, p.newest)
		gl.uniform1f(this.u.u_filled, p.filled)
		gl.uniform1f(this.u.u_rows, p.rows)
		gl.uniform1f(this.u.u_lineHalf, p.lineHalfWidth)
		gl.uniform1f(this.u.u_peakOn, p.peakHold ? 1 : 0)
		gl.uniform1f(this.u.u_gapPx, p.gapPx)
		gl.drawArrays(gl.TRIANGLES, 0, 3)
	}

	dispose(): void {
		const gl = this.gl
		gl.deleteTexture(this.wf)
		gl.deleteTexture(this.peak)
		gl.deleteTexture(this.ramp)
		gl.deleteVertexArray(this.vao)
		gl.deleteProgram(this.program)
	}
}

/** WebGL2 context options for the spectrum canvas. */
export const CONTEXT_OPTIONS: WebGLContextAttributes = {
	alpha: false,
	antialias: false,
	depth: false,
	stencil: false,
	premultipliedAlpha: false,
	preserveDrawingBuffer: false,
	desynchronized: true,
	powerPreference: "high-performance",
}

function bindUnit(
	gl: WebGL2RenderingContext,
	unit: number,
	tex: WebGLTexture,
	loc: WebGLUniformLocation | null,
): void {
	gl.activeTexture(gl.TEXTURE0 + unit)
	gl.bindTexture(gl.TEXTURE_2D, tex)
	gl.uniform1i(loc, unit)
}

function texture(
	gl: WebGL2RenderingContext,
	format: number,
	width: number,
	height: number,
): WebGLTexture {
	const tex = must(gl.createTexture(), "texture")
	gl.bindTexture(gl.TEXTURE_2D, tex)
	gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height)
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
	return tex
}

function link(
	gl: WebGL2RenderingContext,
	vs: string,
	fs: string,
): WebGLProgram {
	const program = must(gl.createProgram(), "program")
	gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs))
	gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs))
	gl.linkProgram(program)
	if (!gl.getProgramParameter(program, gl.LINK_STATUS))
		throw new Error(
			`spectrum shader link failed: ${gl.getProgramInfoLog(program) ?? ""}`,
		)
	return program
}

function compile(
	gl: WebGL2RenderingContext,
	type: number,
	src: string,
): WebGLShader {
	const shader = must(gl.createShader(type), "shader")
	gl.shaderSource(shader, src)
	gl.compileShader(shader)
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
		throw new Error(
			`spectrum shader compile failed: ${gl.getShaderInfoLog(shader) ?? ""}`,
		)
	return shader
}

function must<T>(value: T | null, what: string): T {
	if (value === null) throw new Error(`WebGL2: could not create ${what}`)
	return value
}
