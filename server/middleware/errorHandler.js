/**
 * Error Handler Middleware
 * Provides async route wrapping and centralized error handling
 */

const logger = require('../lib/logger');

/**
 * Wraps an async route handler to catch errors and pass them to next()
 * @param {Function} fn - Async route handler function
 * @returns {Function} Wrapped route handler
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Global error handler middleware
 * Format: { error: string, code?: string }
 * @param {Error} err - Error object
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next function
 */
function errorHandler(err, req, res, next) {
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  const statusCode = err.statusCode || 500;
  const response = {
    error: err.message || 'Internal server error'
  };

  if (err.code) {
    response.code = err.code;
  }

  res.status(statusCode).json(response);
}

module.exports = {
  asyncHandler,
  errorHandler
};
