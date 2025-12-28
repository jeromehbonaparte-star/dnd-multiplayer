/**
 * Security Middleware
 * CSP, CORS, and other security headers
 */

/**
 * Security headers middleware
 */
function securityHeaders(req, res, next) {
  // Content Security Policy - mitigate XSS attacks
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'", // Allow inline scripts for onclick handlers
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:", // Allow WebSocket connections
    "media-src 'self' blob:", // For TTS audio
    "frame-ancestors 'none'", // Prevent clickjacking
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));

  // Other security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // HSTS (only in production with HTTPS)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

/**
 * CORS middleware factory
 * @param {string[]} allowedOrigins - Array of allowed origins
 */
function corsMiddleware(allowedOrigins = []) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    // Allow same-origin requests and configured origins
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Game-Password, X-Admin-Password');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  };
}

module.exports = {
  securityHeaders,
  corsMiddleware
};
