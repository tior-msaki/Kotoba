/**
 * Typed error hierarchy for the app.
 *
 * Each domain throws specific error types so callers can
 * distinguish between "not found" and "invalid input" without parsing strings.
 */

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class StorageError extends AppError {
  constructor(message: string) {
    super(message, "STORAGE_ERROR");
    this.name = "StorageError";
  }
}

export class AnalysisError extends AppError {
  constructor(message: string) {
    super(message, "ANALYSIS_ERROR");
    this.name = "AnalysisError";
  }
}

export class ProviderError extends AppError {
  constructor(
    message: string,
    public readonly provider: string
  ) {
    super(message, "PROVIDER_ERROR");
    this.name = "ProviderError";
  }
}

export class InsufficientCurrencyError extends AppError {
  constructor(
    public readonly required: number,
    public readonly available: number
  ) {
    super(
      `Insufficient currency: need ${required}, have ${available}`,
      "INSUFFICIENT_CURRENCY"
    );
    this.name = "InsufficientCurrencyError";
  }
}
