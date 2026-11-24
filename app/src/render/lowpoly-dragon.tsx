import { useEffect, useRef, useState } from 'react';

type Emotion = 'idle' | 'shy' | 'angry';

type V = { p: [number, number, number]; n: [number, number, number]; c: [number, number, number] };

const TAU = Math.PI * 2;
const WHITE: [number, number, number] = [0.92, 0.89, 0.98];
const LILAC: [number, number, number] = [0.58, 0.45, 0.78];
const PURPLE: [number, number, number] = [0.25, 0.15, 0.38];
const PINK: [number, number, number] = [0.95, 0.38, 0.56];
const GOLD: [number, number, number] = [0.92, 0.72, 0.36];

function addSphere(out: V[], center: [number, number, number], scale: [number, number, number], color: [number, number, number], seg = 10, rings = 6): void {
  for (let r = 0; r < rings; r += 1) {
    const v0 = r / rings;
    const v1 = (r + 1) / rings;
    const p0 = Math.PI * (v0 - 0.5);
    const p1 = Math.PI * (v1 - 0.5);
    for (let s = 0; s < seg; s += 1) {
      const a0 = (s / seg) * TAU;
      const a1 = ((s + 1) / seg) * TAU;
      const q = (lat: number, lon: number): V => {
        const cp = Math.cos(lat);
        const n: [number, number, number] = [cp * Math.cos(lon), Math.sin(lat), cp * Math.sin(lon)];
        return { p: [center[0] + n[0] * scale[0], center[1] + n[1] * scale[1], center[2] + n[2] * scale[2]], n, c: color };
      };
      const a = q(p0, a0); const b = q(p1, a0); const c = q(p1, a1); const d = q(p0, a1);
      out.push(a, b, c, a, c, d);
    }
  }
}

function addCone(out: V[], center: [number, number, number], radius: number, height: number, color: [number, number, number], seg = 8): void {
  const top: [number, number, number] = [center[0], center[1] + height / 2, center[2]];
  const bottom: [number, number, number] = [center[0], center[1] - height / 2, center[2]];
  for (let i = 0; i < seg; i += 1) {
    const a0 = (i / seg) * TAU; const a1 = ((i + 1) / seg) * TAU;
    const p0: [number, number, number] = [bottom[0] + Math.cos(a0) * radius, bottom[1], bottom[2] + Math.sin(a0) * radius];
    const p1: [number, number, number] = [bottom[0] + Math.cos(a1) * radius, bottom[1], bottom[2] + Math.sin(a1) * radius];
    const n0: [number, number, number] = [Math.cos(a0), radius / height, Math.sin(a0)];
    const n1: [number, number, number] = [Math.cos(a1), radius / height, Math.sin(a1)];
    out.push({ p: p0, n: n0, c: color }, { p: top, n: [0, 1, 0], c: color }, { p: p1, n: n1, c: color });
  }
}

function addWing(out: V[], side: number): void {
  const c: [number, number, number] = [0.64, 0.51, 0.82];
  const z = -0.02;
  const pts: [number, number, number][] = [
    [side * 0.58, 0.85, z], [side * 1.72, 1.55, z - 0.08], [side * 1.46, 0.35, z - 0.18],
    [side * 0.95, 0.04, z - 0.1], [side * 0.62, 0.45, z],
  ];
  const n: [number, number, number] = [side * 0.15, 0.45, 0.88];
  for (let i = 1; i < pts.length - 1; i += 1) out.push({ p: pts[0], n, c }, { p: pts[i], n, c }, { p: pts[i + 1], n, c });
}

function buildDragon(emotion: Emotion): Float32Array {
  const v: V[] = [];
  addSphere(v, [0, -0.12, 0], [0.63, 1.0, 0.42], WHITE, 12, 7);
  // Back hair and two long side locks give the low-poly silhouette the
  // white-haired dragon-girl shape from the reference without a texture map.
  addSphere(v, [0, 0.78, -0.22], [0.88, 0.92, 0.28], LILAC, 12, 6);
  addSphere(v, [-0.62, 0.48, -0.02], [0.27, 0.78, 0.25], WHITE, 9, 5);
  addSphere(v, [0.62, 0.48, -0.02], [0.27, 0.78, 0.25], WHITE, 9, 5);
  addSphere(v, [0, 0.72, 0.04], [0.75, 0.76, 0.58], WHITE, 12, 7);
  addSphere(v, [0, 1.13, 0.52], [0.60, 0.22, 0.08], WHITE, 10, 4);
  addSphere(v, [0, 0.12, 0.18], [0.82, 0.72, 0.48], LILAC, 12, 5);
  addSphere(v, [-0.24, 0.82, 0.55], [0.13, 0.18, 0.08], PURPLE, 8, 4);
  addSphere(v, [0.24, 0.82, 0.55], [0.13, 0.18, 0.08], PURPLE, 8, 4);
  addSphere(v, [-0.24, 0.84, 0.62], [0.045, 0.07, 0.03], emotion === 'angry' ? PINK : GOLD, 6, 3);
  addSphere(v, [0.24, 0.84, 0.62], [0.045, 0.07, 0.03], emotion === 'angry' ? PINK : GOLD, 6, 3);
  addSphere(v, [0, 0.59, 0.60], [0.07, 0.035, 0.025], PURPLE, 6, 3);
  addCone(v, [-0.34, 1.43, 0.02], 0.16, 0.62, WHITE, 7);
  addCone(v, [0.34, 1.43, 0.02], 0.16, 0.62, WHITE, 7);
  addSphere(v, [-0.98, 0.42, 0.05], [0.18, 0.52, 0.14], WHITE, 8, 5);
  addSphere(v, [0.98, 0.42, 0.05], [0.18, 0.52, 0.14], WHITE, 8, 5);
  addSphere(v, [-0.23, -1.08, 0.06], [0.19, 0.42, 0.16], WHITE, 8, 5);
  addSphere(v, [0.23, -1.08, 0.06], [0.19, 0.42, 0.16], WHITE, 8, 5);
  addWing(v, -1); addWing(v, 1);
  addSphere(v, [0.92, -0.12, -0.08], [0.43, 0.28, 0.25], LILAC, 9, 5);
  addSphere(v, [1.25, -0.05, -0.16], [0.42, 0.22, 0.2], LILAC, 9, 5);
  addSphere(v, [1.52, 0.10, -0.20], [0.35, 0.17, 0.15], WHITE, 8, 4);
  if (emotion === 'shy') {
    addSphere(v, [-0.40, 0.58, 0.54], [0.14, 0.07, 0.025], PINK, 8, 3);
    addSphere(v, [0.40, 0.58, 0.54], [0.14, 0.07, 0.025], PINK, 8, 3);
  }
  const data = new Float32Array(v.length * 9);
  v.forEach((x, i) => { data.set([...x.p, ...x.n, ...x.c], i * 9); });
  return data;
}

function perspective(out: Float32Array): void {
  // The canvas is portrait, but the dragon's wings and tail need the same
  // world-space margin on both axes.  This keeps the low-poly silhouette from
  // being squeezed or clipped when the transparent desktop window is resized.
  const s = 2.15;
  out.set([1 / s, 0, 0, 0, 0, 1 / s, 0, 0, 0, 0, -0.18, 0, 0, 0, 0, 1]);
}

function drawProjectedDragon(canvas: HTMLCanvasElement, emotion: Emotion): void {
  const context = canvas.getContext('2d');
  if (!context) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  canvas.width = width;
  canvas.height = height;

  const vertices = buildDragon(emotion);
  const triangleSize = 27;
  const viewSize = 4.3;
  const lightLength = Math.hypot(-0.45, 0.85, 0.75);
  const triangles = Array.from({ length: vertices.length / triangleSize }, (_, index) => {
    const start = index * triangleSize;
    return {
      start,
      depth: vertices[start + 2] + vertices[start + 11] + vertices[start + 20],
    };
  }).sort((a, b) => a.depth - b.depth);

  for (const { start } of triangles) {
    const nx = vertices[start + 3] + vertices[start + 12] + vertices[start + 21];
    const ny = vertices[start + 4] + vertices[start + 13] + vertices[start + 22];
    const nz = vertices[start + 5] + vertices[start + 14] + vertices[start + 23];
    const normalLength = Math.hypot(nx, ny, nz) || 1;
    const diffuse = Math.max(0, (-0.45 * nx + 0.85 * ny + 0.75 * nz) / (normalLength * lightLength));
    const shade = diffuse * 0.42 + 0.58;
    const red = Math.round(vertices[start + 6] * shade * 255);
    const green = Math.round(vertices[start + 7] * shade * 255);
    const blue = Math.round(vertices[start + 8] * shade * 255);
    context.fillStyle = `rgb(${red} ${green} ${blue})`;
    context.beginPath();
    for (let corner = 0; corner < 3; corner += 1) {
      const i = start + 9 * corner;
      const x = (0.5 + vertices[i] / viewSize) * width;
      const y = (0.5 - vertices[i + 1] / viewSize) * height;
      if (corner === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.fill();
  }
}

export function LowPolyDragon({ emotion }: { emotion: Emotion }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const [useSoftware, setUseSoftware] = useState(false);
  const emotionRef = useRef(emotion); emotionRef.current = emotion;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || useSoftware) return;
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: true });
    if (!gl) {
      setUseSoftware(true);
      return;
    }
    const vs = `attribute vec3 p; attribute vec3 n; attribute vec3 c; uniform mat4 proj; uniform float rx; uniform float ry; uniform float t; varying vec3 vc; varying vec3 vn; void main(){float cy=cos(ry),sy=sin(ry),cx=cos(rx),sx=sin(rx); vec3 q=vec3(cy*p.x+sy*p.z, p.y, -sy*p.x+cy*p.z); float tail=clamp((p.x-0.72)/0.92,0.0,1.0); float sway=sin(t*1.55+p.x*2.2)*0.075*tail; q.z += sway; q.x += sin(t*1.05+p.x*1.6)*0.035*tail; q.y += sin(t*1.7)*0.045; q=vec3(q.x,cx*q.y-sx*q.z,sx*q.y+cx*q.z); gl_Position=proj*vec4(q,1.0); vc=c; vn=n;}`;
    const fs = `precision mediump float; varying vec3 vc; varying vec3 vn; void main(){vec3 l=normalize(vec3(-0.45,0.85,0.75)); float d=max(dot(normalize(vn),l),0.0); float shade=0.58+d*0.42; gl_FragColor=vec4(vc*shade,1.0);}`;
    const compile = (type: number, src: string): WebGLShader => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const vertexShader = compile(gl.VERTEX_SHADER, vs);
    const fragmentShader = compile(gl.FRAGMENT_SHADER, fs);
    const program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      setUseSoftware(true);
      return;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const pLoc = gl.getAttribLocation(program, 'p'); const nLoc = gl.getAttribLocation(program, 'n'); const cLoc = gl.getAttribLocation(program, 'c');
    gl.enableVertexAttribArray(pLoc); gl.vertexAttribPointer(pLoc, 3, gl.FLOAT, false, 36, 0);
    gl.enableVertexAttribArray(nLoc); gl.vertexAttribPointer(nLoc, 3, gl.FLOAT, false, 36, 12);
    gl.enableVertexAttribArray(cLoc); gl.vertexAttribPointer(cLoc, 3, gl.FLOAT, false, 36, 24);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const proj = new Float32Array(16); const projLoc = gl.getUniformLocation(program, 'proj'); const rxLoc = gl.getUniformLocation(program, 'rx'); const ryLoc = gl.getUniformLocation(program, 'ry'); const tLoc = gl.getUniformLocation(program, 't');
    let raf = 0; const started = performance.now(); let lastEmotion: Emotion | null = null; let vertices = 0;
    const draw = (now: number) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1); const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)); const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
      if (lastEmotion !== emotionRef.current) { const data = buildDragon(emotionRef.current); vertices = data.length / 9; gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); lastEmotion = emotionRef.current; }
      perspective(proj); gl.uniformMatrix4fv(projLoc, false, proj); const t = (now - started) / 1000; gl.uniform1f(tLoc, t); gl.uniform1f(rxLoc, Math.sin(t * 0.7) * 0.035); gl.uniform1f(ryLoc, Math.sin(t * 0.55) * 0.06); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, vertices); raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const handleContextLoss = () => setUseSoftware(true);
    canvas.addEventListener('webglcontextlost', handleContextLoss);
    return () => {
      canvas.removeEventListener('webglcontextlost', handleContextLoss);
      cancelAnimationFrame(raf);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, [useSoftware]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !useSoftware) return;
    const draw = () => drawProjectedDragon(canvas, emotion);
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [emotion, useSoftware]);

  return <canvas key={useSoftware ? '2d' : 'webgl'} ref={ref} className="fallback-dragon-3d__canvas" aria-label="内置小龙娘" />;
}
