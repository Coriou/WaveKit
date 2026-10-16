/**
 * WebGL2 renderer for the spectrum trace (top band) and waterfall (bottom band), one full-screen pass.
 * Shared by the OffscreenCanvas worker path and the main-thread fallback: it only needs a
 * WebGL2RenderingContext. The waterfall is an R8 texture used as a ring (one texSubImage2D per row);
 * levels, view mapping and ring position are uniforms, so a view or level change re-uploads nothing.
 */

import { RAMP_SIZE } from "./ramp.ts"

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

float rowV(float age) {
	float index = mod(u_newest - age + u_depth, u_depth);
	return (index + 0.5) / u_depth;
}

float level(float s) {
	return s * u_level.x + u_level.y;
}

// y of the trace at screen px x, device px from the top of the trace band.
float traceY(sampler2D tex, float v, float px) {
	float t = clamp(level(texture(tex, vec2(clampU(texU(px)), v)).r), 0.0, 1.0);
	float top = 2.0 * u_lineHalf;
	return top + (1.0 - t) * (u_tracePx - top - 1.0);
}

// Coverage of a vertical stroke through the trace at px (bridges steep slopes between neighbours).
float stroke(sampler2D tex, float v, float px, float y, float halfWidth) {
	float y0 = traceY(tex, v, px - 0.5);
	float y1 = traceY(tex, v, px + 0.5);
	float yc = traceY(tex, v, px);
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

	if (y >= u_tracePx) {
		// Waterfall: newest row at the top of the band.
		float wy = (y - u_tracePx) / max(u_size.y - u_tracePx, 1.0);
		float age = floor(wy * u_rows);
		if (!hasData || age >= u_filled) {
			outColor = bg;
			return;
		}
		float s = texture(u_wf, vec2(clampU(u), rowV(age))).r;
		outColor = vec4(ramp(level(s)).rgb, 1.0);
		return;
	}

	vec3 color = bg.rgb;
	if (hasData) {
		float v = rowV(0.0);
		float yc = traceY(u_wf, v, px);
		vec4 lineColor = ramp(0.82);
		if (y > yc) {
			float depth = (y - yc) / max(u_tracePx - yc, 1.0);
			color = mix(color, lineColor.rgb, mix(0.32, 0.04, depth));
		}
		if (u_peakOn > 0.5) {
			float p = stroke(u_peak, 0.5, px, y, u_lineHalf * 0.6);
			color = mix(color, ramp(1.0).rgb, 0.55 * p);
		}
		float c = stroke(u_wf, v, px, y, u_lineHalf);
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
	| "u_peakOn",
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
