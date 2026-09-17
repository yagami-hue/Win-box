// src/engine/util/errors.ts
export class EngineError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'EngineError';
  }
}

export class UnsupportedSourceError extends EngineError {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'UnsupportedSourceError';
  }
}
