type MatrixSource = ArrayLike<number> | {
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  e?: number;
  f?: number;
};

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function matrixValues(source?: MatrixSource | null): [number, number, number, number, number, number] {
  if (!source) return [1, 0, 0, 1, 0, 0];
  if (typeof (source as ArrayLike<number>).length === "number") {
    const values = source as ArrayLike<number>;
    if (values.length === 6) {
      return [
        finiteOr(values[0], 1), finiteOr(values[1], 0), finiteOr(values[2], 0),
        finiteOr(values[3], 1), finiteOr(values[4], 0), finiteOr(values[5], 0),
      ];
    }
    if (values.length === 16) {
      return [
        finiteOr(values[0], 1), finiteOr(values[1], 0), finiteOr(values[4], 0),
        finiteOr(values[5], 1), finiteOr(values[12], 0), finiteOr(values[13], 0),
      ];
    }
  }
  const values = source as Exclude<MatrixSource, ArrayLike<number>>;
  return [
    finiteOr(values.a, 1), finiteOr(values.b, 0), finiteOr(values.c, 0),
    finiteOr(values.d, 1), finiteOr(values.e, 0), finiteOr(values.f, 0),
  ];
}

/** PDF.js only needs this 2D affine subset while extracting text and operators. */
class WorkerDomMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;

  constructor(source?: MatrixSource | null) {
    [this.a, this.b, this.c, this.d, this.e, this.f] = matrixValues(source);
  }

  get m11(): number { return this.a; }
  set m11(value: number) { this.a = value; }
  get m12(): number { return this.b; }
  set m12(value: number) { this.b = value; }
  get m13(): number { return 0; }
  set m13(_value: number) {}
  get m14(): number { return 0; }
  set m14(_value: number) {}
  get m21(): number { return this.c; }
  set m21(value: number) { this.c = value; }
  get m22(): number { return this.d; }
  set m22(value: number) { this.d = value; }
  get m23(): number { return 0; }
  set m23(_value: number) {}
  get m24(): number { return 0; }
  set m24(_value: number) {}
  get m31(): number { return 0; }
  set m31(_value: number) {}
  get m32(): number { return 0; }
  set m32(_value: number) {}
  get m33(): number { return 1; }
  set m33(_value: number) {}
  get m34(): number { return 0; }
  set m34(_value: number) {}
  get m41(): number { return this.e; }
  set m41(value: number) { this.e = value; }
  get m42(): number { return this.f; }
  set m42(value: number) { this.f = value; }
  get m43(): number { return 0; }
  set m43(_value: number) {}
  get m44(): number { return 1; }
  set m44(_value: number) {}

  get is2D(): boolean { return true; }
  get isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0
      && this.d === 1 && this.e === 0 && this.f === 0;
  }

  multiply(other?: MatrixSource | null): WorkerDomMatrix {
    return new WorkerDomMatrix(this).multiplySelf(other);
  }

  multiplySelf(other?: MatrixSource | null): this {
    const [a, b, c, d, e, f] = matrixValues(other);
    const { a: a1, b: b1, c: c1, d: d1, e: e1, f: f1 } = this;
    this.a = a1 * a + c1 * b;
    this.b = b1 * a + d1 * b;
    this.c = a1 * c + c1 * d;
    this.d = b1 * c + d1 * d;
    this.e = a1 * e + c1 * f + e1;
    this.f = b1 * e + d1 * f + f1;
    return this;
  }

  preMultiplySelf(other?: MatrixSource | null): this {
    const result = new WorkerDomMatrix(other).multiplySelf(this);
    [this.a, this.b, this.c, this.d, this.e, this.f] = matrixValues(result);
    return this;
  }

  translate(tx = 0, ty = 0, tz = 0): WorkerDomMatrix {
    return new WorkerDomMatrix(this).translateSelf(tx, ty, tz);
  }

  translateSelf(tx = 0, ty = 0, _tz = 0): this {
    void _tz;
    return this.multiplySelf([1, 0, 0, 1, tx, ty]);
  }

  scale(
    scaleX = 1, scaleY = scaleX, scaleZ = 1,
    originX = 0, originY = 0, originZ = 0,
  ): WorkerDomMatrix {
    return new WorkerDomMatrix(this).scaleSelf(scaleX, scaleY, scaleZ, originX, originY, originZ);
  }

  scaleSelf(
    scaleX = 1, scaleY = scaleX, _scaleZ = 1,
    originX = 0, originY = 0, _originZ = 0,
  ): this {
    void _scaleZ;
    void _originZ;
    if (originX !== 0 || originY !== 0) this.translateSelf(originX, originY);
    this.multiplySelf([scaleX, 0, 0, scaleY, 0, 0]);
    if (originX !== 0 || originY !== 0) this.translateSelf(-originX, -originY);
    return this;
  }

  inverse(): WorkerDomMatrix {
    return new WorkerDomMatrix(this).invertSelf();
  }

  invertSelf(): this {
    const determinant = this.a * this.d - this.b * this.c;
    if (!Number.isFinite(determinant) || determinant === 0) {
      this.a = this.b = this.c = this.d = this.e = this.f = Number.NaN;
      return this;
    }
    const { a, b, c, d, e, f } = this;
    this.a = d / determinant;
    this.b = -b / determinant;
    this.c = -c / determinant;
    this.d = a / determinant;
    this.e = (c * f - d * e) / determinant;
    this.f = (b * e - a * f) / determinant;
    return this;
  }

  toFloat32Array(): Float32Array { return new Float32Array(this.toArray()); }
  toFloat64Array(): Float64Array { return new Float64Array(this.toArray()); }
  toString(): string { return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`; }

  private toArray(): number[] {
    return [
      this.a, this.b, 0, 0,
      this.c, this.d, 0, 0,
      0, 0, 1, 0,
      this.e, this.f, 0, 1,
    ];
  }
}

export function ensurePdfDomMatrix(): void {
  const scope = globalThis as { DOMMatrix?: typeof DOMMatrix };
  if (scope.DOMMatrix) return;
  Object.defineProperty(scope, "DOMMatrix", {
    configurable: true,
    writable: true,
    value: WorkerDomMatrix as unknown as typeof DOMMatrix,
  });
}

export async function loadPdfJs(): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> {
  ensurePdfDomMatrix();
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}
