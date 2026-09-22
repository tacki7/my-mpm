// Runs batches of the 3D model's step on a WebGPU device (kernels.ts) and hands the state back: the particle
// buffer, the batch's force sums, and the deflection the CPU controls set. Sim3.advanceBatch packs the state,
// fills the uniforms and reads the result; this class only owns the device's objects.
import { DISPATCH_MAX, NSLOT, PSTRIDE, UCOUNT, USTRIDE, WG, WGSL } from './kernels.ts';

export interface GpuGeometry {
  n: number;
  nxN: number;
  nyN: number;
  nzN: number;
}

/** what one batch returns: the particles (PSTRIDE floats each) and the sums (2 nxN of fy, tq; then ng of the contact's normal force per node, then ng of followRoll's) */
export interface GpuBatch {
  particles: Float32Array;
  acc: Float32Array;
}

/** the kind of adapter the device came from, for the page and the docs */
export interface GpuInfo {
  vendor: string;
  architecture: string;
  device: string;
  /** the backend the adapter reported, when it does ('metal', 'vulkan', 'd3d12', ...; '' when unknown) */
  backend: string;
}

/** the limits a device is asked for: the adapter's own where they are above the defaults, so a big strip fits */
const RAISED: (keyof GPUSupportedLimits)[] = ['maxStorageBufferBindingSize', 'maxBufferSize', 'maxComputeWorkgroupsPerDimension'];

function infoOf(adapter: GPUAdapter): GpuInfo {
  const a = adapter.info as (GPUAdapterInfo & { backend?: string }) | undefined;
  return { vendor: a?.vendor ?? '', architecture: a?.architecture ?? '', device: a?.device ?? '', backend: a?.backend ?? '' };
}

async function deviceOf(adapter: GPUAdapter): Promise<GPUDevice> {
  const requiredLimits: Record<string, number> = {};
  for (const k of RAISED) {
    const v = adapter.limits[k];
    if (typeof v === 'number') requiredLimits[k] = v;
  }
  try {
    return await adapter.requestDevice({ requiredLimits });
  } catch {
    // an adapter that will not grant its own limits (seen on some drivers): the defaults, then
    return await adapter.requestDevice();
  }
}

/**
 * A device, or null where WebGPU is not there (a browser without it, an insecure page, a CPU-only Chrome).
 * The high-performance adapter where the browser offers a choice (a discrete GPU next to an integrated one),
 * with its own limits on buffer size and dispatch width. Any backend: nothing here is Metal's or Vulkan's.
 */
export async function requestGpu(): Promise<{ device: GPUDevice; info: GpuInfo } | null> {
  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
  if (!gpu) return null;
  const adapter = (await gpu.requestAdapter({ powerPreference: 'high-performance' })) ?? (await gpu.requestAdapter());
  if (!adapter) return null;
  const device = await deviceOf(adapter);
  return { device, info: infoOf(adapter) };
}

/**
 * Every distinct adapter the browser offers, each with a device: WebGPU exposes no list of GPUs, only a choice
 * by power preference, so a machine with two kinds of GPU (a discrete one and an integrated one) yields two,
 * and a machine with several GPUs of one kind yields one (the browser picks). For work that is independent —
 * several passes at once (tools/gpu/check.ts) — the jobs go round the pool; one pass is not split across
 * devices (its grid would cross the host every step, slower than one GPU alone).
 */
export async function requestGpuPool(): Promise<{ device: GPUDevice; info: GpuInfo }[]> {
  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
  if (!gpu) return [];
  const seen = new Map<string, GPUAdapter>();
  for (const powerPreference of ['high-performance', 'low-power'] as const) {
    const a = await gpu.requestAdapter({ powerPreference });
    if (!a || (a as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter) continue;
    const i = infoOf(a);
    const key = `${i.vendor}|${i.architecture}|${i.device}|${a.limits.maxBufferSize}|${a.limits.maxComputeWorkgroupsPerDimension}`;
    if (!seen.has(key)) seen.set(key, a);
  }
  const out: { device: GPUDevice; info: GpuInfo }[] = [];
  for (const a of seen.values()) out.push({ device: await deviceOf(a), info: infoOf(a) });
  return out;
}

/** the bytes the stepper would allocate for a geometry, against a device's limits: the reason it will not fit, or null */
export function gpuFit(device: GPUDevice, geo: GpuGeometry): string | null {
  const ng = geo.nxN * geo.nyN * geo.nzN;
  const L = device.limits;
  const sizes: [string, number][] = [
    ['粒子', geo.n * PSTRIDE * 4],
    ['格子', NSLOT * ng * 4],
    ['和', (2 * geo.nxN + 2 * ng) * 4],
  ];
  for (const [what, bytes] of sizes) {
    if (bytes > L.maxStorageBufferBindingSize || bytes > L.maxBufferSize) {
      const lim = Math.min(L.maxStorageBufferBindingSize, L.maxBufferSize);
      return `${what}のバッファが ${(bytes / 2 ** 20).toFixed(0)} MiB で、この GPU の上限 ${(lim / 2 ** 20).toFixed(0)} MiB を超える`;
    }
  }
  const wgMax = Math.max(Math.ceil(geo.n / WG), Math.ceil(ng / WG));
  if (wgMax > DISPATCH_MAX * L.maxComputeWorkgroupsPerDimension) return `ワークグループ ${wgMax} 個で、この GPU の 1 回の起動の上限を超える`;
  return null;
}

export class GpuStepper {
  readonly device: GPUDevice;
  readonly geo: GpuGeometry;
  readonly ng: number;
  private readonly ubuf: GPUBuffer;
  private readonly pbuf: GPUBuffer;
  private readonly gbuf: GPUBuffer;
  private readonly abuf: GPUBuffer;
  private readonly bbuf: GPUBuffer;
  private readonly pRead: GPUBuffer;
  private readonly aRead: GPUBuffer;
  private readonly bind: GPUBindGroup;
  private readonly pipes: Record<string, GPUComputePipeline>;
  private readonly uniforms: ArrayBuffer;
  /** the last readback (reused: the caller copies what it keeps) */
  private readonly particles: Float32Array;
  private readonly acc: Float32Array;
  private errors: string[] = [];
  /** debug: leave followRoll out (tools/gpu/check.ts isolates the stages) */
  skipFollow = false;
  private checked = false;
  private destroyed = false;

  constructor(device: GPUDevice, geo: GpuGeometry) {
    this.device = device;
    this.geo = geo;
    this.ng = geo.nxN * geo.nyN * geo.nzN;
    const unfit = gpuFit(device, geo);
    if (unfit) throw new Error(unfit);
    const pBytes = geo.n * PSTRIDE * 4;
    const aBytes = (2 * geo.nxN + 2 * this.ng) * 4;
    const U = GPUBufferUsage;
    this.ubuf = device.createBuffer({ size: UCOUNT * USTRIDE, usage: U.UNIFORM | U.COPY_DST });
    this.pbuf = device.createBuffer({ size: pBytes, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC });
    this.gbuf = device.createBuffer({ size: NSLOT * this.ng * 4, usage: U.STORAGE | U.COPY_DST });
    this.abuf = device.createBuffer({ size: aBytes, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC });
    this.bbuf = device.createBuffer({ size: 2 * geo.nzN * 4, usage: U.STORAGE | U.COPY_DST });
    this.pRead = device.createBuffer({ size: pBytes, usage: U.COPY_DST | U.MAP_READ });
    this.aRead = device.createBuffer({ size: aBytes, usage: U.COPY_DST | U.MAP_READ });
    this.uniforms = new ArrayBuffer(UCOUNT * USTRIDE);
    this.particles = new Float32Array(geo.n * PSTRIDE);
    this.acc = new Float32Array(2 * geo.nxN + 2 * this.ng);
    device.addEventListener('uncapturederror', (e) => this.errors.push(String((e as GPUUncapturedErrorEvent).error?.message ?? e)));
    const module = device.createShaderModule({ code: WGSL });
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.bind = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.ubuf, size: USTRIDE } },
        { binding: 1, resource: { buffer: this.pbuf } },
        { binding: 2, resource: { buffer: this.gbuf } },
        { binding: 3, resource: { buffer: this.abuf } },
        { binding: 4, resource: { buffer: this.bbuf } },
      ],
    });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipe = (entryPoint: string) => device.createComputePipeline({ layout: pl, compute: { module, entryPoint } });
    this.pipes = {};
    for (const k of ['p2g', 'fold', 'grid', 'folA', 'folB', 'mirror', 'g2pv', 'vmean', 'g2pu']) this.pipes[k] = pipe(k);
  }

  /** the shader's compile errors, if any (the pipelines fail silently otherwise) */
  async compileErrors(): Promise<string | null> {
    const module = this.device.createShaderModule({ code: WGSL });
    const info = await module.getCompilationInfo();
    const errs = info.messages.filter((m) => m.type === 'error');
    return errs.length ? errs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n') : null;
  }

  /** the particle state onto the device */
  upload(particles: Float32Array): void {
    this.device.queue.writeBuffer(this.pbuf, 0, particles.buffer, particles.byteOffset, particles.byteLength);
  }

  /** the uniform entry of step s of the batch (u32 and f32 views on the same bytes) */
  uniform(s: number): { f: Float32Array; u: Uint32Array } {
    return { f: new Float32Array(this.uniforms, s * USTRIDE, USTRIDE / 4), u: new Uint32Array(this.uniforms, s * USTRIDE, USTRIDE / 4) };
  }

  /**
   * K steps (the uniform entries 0..K−1 filled by the caller), then the particles and the batch's sums read back.
   * The sums start at zero each batch. `bend`: the roll's deflection by z column and its rate, 2 nzN floats.
   */
  async run(K: number, bend: Float32Array): Promise<GpuBatch> {
    if (this.destroyed) throw new Error('the GPU stepper was destroyed');
    if (!(K >= 1 && K <= UCOUNT)) throw new Error(`a batch is 1 to ${UCOUNT} steps`);
    if (this.errors.length) throw new Error('WebGPU: ' + this.errors.join('\n'));
    const { device, geo, ng } = this;
    const q = device.queue;
    q.writeBuffer(this.ubuf, 0, this.uniforms, 0, K * USTRIDE);
    q.writeBuffer(this.bbuf, 0, bend.buffer, bend.byteOffset, bend.byteLength);
    if (!this.checked) device.pushErrorScope('validation');
    const enc = device.createCommandEncoder();
    enc.clearBuffer(this.abuf);
    const P = this.pipes;
    // a dispatch of w workgroups as rows of at most DISPATCH_MAX (the default limit per dimension); kernels.ts tid()
    const dispatch = (pass: GPUComputePassEncoder, pipe: GPUComputePipeline, w: number) => {
      pass.setPipeline(pipe);
      if (w <= DISPATCH_MAX) pass.dispatchWorkgroups(w);
      else pass.dispatchWorkgroups(DISPATCH_MAX, Math.ceil(w / DISPATCH_MAX));
    };
    const wgP = Math.ceil(geo.n / WG);
    const wgX = Math.ceil(geo.nxN / WG);
    const wgG = Math.ceil(ng / WG);
    for (let s = 0; s < K; s++) {
      enc.clearBuffer(this.gbuf);
      const pass = enc.beginComputePass();
      pass.setBindGroup(0, this.bind, [s * USTRIDE]);
      dispatch(pass, P.p2g, wgP);
      dispatch(pass, P.fold, wgX);
      dispatch(pass, P.grid, wgG);
      if (!this.skipFollow) {
        dispatch(pass, P.folA, wgP);
        dispatch(pass, P.folB, wgG);
      }
      dispatch(pass, P.mirror, wgX);
      dispatch(pass, P.g2pv, wgP);
      dispatch(pass, P.vmean, wgX);
      dispatch(pass, P.g2pu, wgP);
      pass.end();
    }
    enc.copyBufferToBuffer(this.pbuf, 0, this.pRead, 0, this.pRead.size);
    enc.copyBufferToBuffer(this.abuf, 0, this.aRead, 0, this.aRead.size);
    q.submit([enc.finish()]);
    if (!this.checked) {
      this.checked = true;
      const err = await device.popErrorScope();
      if (err) throw new Error('WebGPU validation: ' + err.message);
    }
    await Promise.all([this.pRead.mapAsync(GPUMapMode.READ), this.aRead.mapAsync(GPUMapMode.READ)]);
    this.particles.set(new Float32Array(this.pRead.getMappedRange()));
    this.acc.set(new Float32Array(this.aRead.getMappedRange()));
    this.pRead.unmap();
    this.aRead.unmap();
    if (this.errors.length) throw new Error('WebGPU: ' + this.errors.join('\n'));
    return { particles: this.particles, acc: this.acc };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const b of [this.ubuf, this.pbuf, this.gbuf, this.abuf, this.bbuf, this.pRead, this.aRead]) b.destroy();
  }
}
