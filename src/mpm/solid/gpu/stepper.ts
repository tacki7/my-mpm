// Runs batches of the 3D model's step on a WebGPU device (kernels.ts) and hands the state back: the particle
// buffer, the batch's force sums, and the deflection the CPU controls set. Sim3.advanceBatch packs the state,
// fills the uniforms and reads the result; this class only owns the device's objects.
import { NSLOT, PSTRIDE, UCOUNT, USTRIDE, WGSL } from './kernels.ts';

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
}

/** the device, or null where WebGPU is not there (a browser without it, an insecure page, a CPU-only Chrome) */
export async function requestGpu(): Promise<{ device: GPUDevice; info: GpuInfo } | null> {
  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const a = adapter.info;
  return { device, info: { vendor: a?.vendor ?? '', architecture: a?.architecture ?? '', device: a?.device ?? '' } };
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
    const wgP = Math.ceil(geo.n / 64);
    const wgX = Math.ceil(geo.nxN / 64);
    const wgG = Math.ceil(ng / 64);
    const P = this.pipes;
    for (let s = 0; s < K; s++) {
      enc.clearBuffer(this.gbuf);
      const pass = enc.beginComputePass();
      pass.setBindGroup(0, this.bind, [s * USTRIDE]);
      pass.setPipeline(P.p2g); pass.dispatchWorkgroups(wgP);
      pass.setPipeline(P.fold); pass.dispatchWorkgroups(wgX);
      pass.setPipeline(P.grid); pass.dispatchWorkgroups(wgG);
      if (!this.skipFollow) {
        pass.setPipeline(P.folA); pass.dispatchWorkgroups(wgP);
        pass.setPipeline(P.folB); pass.dispatchWorkgroups(wgG);
      }
      pass.setPipeline(P.mirror); pass.dispatchWorkgroups(wgX);
      pass.setPipeline(P.g2pv); pass.dispatchWorkgroups(wgP);
      pass.setPipeline(P.vmean); pass.dispatchWorkgroups(wgX);
      pass.setPipeline(P.g2pu); pass.dispatchWorkgroups(wgP);
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
