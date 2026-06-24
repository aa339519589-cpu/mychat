class ValidationError extends Error {
  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.name = 'ValidationError'
  }
}

export const validate = {
  string: (value: unknown, fieldName: string, opts?: { minLength?: number; maxLength?: number }): string => {
    if (typeof value !== 'string') {
      throw new ValidationError(fieldName, 'must be a string')
    }
    if (opts?.minLength && value.length < opts.minLength) {
      throw new ValidationError(fieldName, `must be at least ${opts.minLength} characters`)
    }
    if (opts?.maxLength && value.length > opts.maxLength) {
      throw new ValidationError(fieldName, `must be at most ${opts.maxLength} characters`)
    }
    return value
  },

  uuid: (value: unknown, fieldName: string): string => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (typeof value !== 'string' || !uuidRegex.test(value)) {
      throw new ValidationError(fieldName, 'must be a valid UUID')
    }
    return value
  },

  number: (value: unknown, fieldName: string, opts?: { min?: number; max?: number; isInteger?: boolean }): number => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new ValidationError(fieldName, 'must be a number')
    }
    if (opts?.isInteger && !Number.isInteger(value)) {
      throw new ValidationError(fieldName, 'must be an integer')
    }
    if (opts?.min !== undefined && value < opts.min) {
      throw new ValidationError(fieldName, `must be at least ${opts.min}`)
    }
    if (opts?.max !== undefined && value > opts.max) {
      throw new ValidationError(fieldName, `must be at most ${opts.max}`)
    }
    return value
  },

  array: (value: unknown, fieldName: string, opts?: { minLength?: number; maxLength?: number }): unknown[] => {
    if (!Array.isArray(value)) {
      throw new ValidationError(fieldName, 'must be an array')
    }
    if (opts?.minLength && value.length < opts.minLength) {
      throw new ValidationError(fieldName, `must have at least ${opts.minLength} items`)
    }
    if (opts?.maxLength && value.length > opts.maxLength) {
      throw new ValidationError(fieldName, `must have at most ${opts.maxLength} items`)
    }
    return value
  },
}
