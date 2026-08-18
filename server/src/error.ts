/**
 * 커스텀 에러 클래스 모음
 */

/**
 * 인증 에러 클래스
 */
export class AuthError extends Error {
  constructor(
    public message: string,
    public code: string = 'AUTH_ERROR',
    public statusCode: number = 401
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * 검증 에러 클래스
 */
export class ValidationError extends Error {
  constructor(
    public message: string,
    public code: string = 'VALIDATION_ERROR',
    public statusCode: number = 400
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

/**
 * 내부 서버 에러 클래스
 */
export class InternalError extends Error {
  constructor(
    public message: string,
    public code: string = 'INTERNAL_ERROR',
    public statusCode: number = 500
  ) {
    super(message)
    this.name = 'InternalError'
  }
}
