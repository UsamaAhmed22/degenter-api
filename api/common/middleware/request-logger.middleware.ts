function headerValue(v: any) {
  if (!v) return null;
  if (Array.isArray(v)) return v[0];
  return String(v);
}

function ensureRequestId(req: any, res: any) {
  const incoming = headerValue(req.headers?.['x-request-id']);
  const rid = incoming || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  res.setHeader('x-request-id', rid);
  return rid;
}

export function requestLogger(req: any, res: any, next: any) {
  const start = process.hrtime.bigint();
  const requestId = ensureRequestId(req, res);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const status = res.statusCode || 0;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    const log = {
      ts: new Date().toISOString(),
      level,
      msg: 'http_request',
      request_id: requestId,
      method: req.method,
      path: req.path,
      url: req.originalUrl || req.url,
      status,
      duration_ms: Math.round(durationMs * 100) / 100,
      ip: req.ip || null,
      ips: req.ips || null,
      forwarded_for: headerValue(req.headers?.['x-forwarded-for']),
      real_ip: headerValue(req.headers?.['x-real-ip']),
      user_agent: headerValue(req.headers?.['user-agent']),
      referer: headerValue(req.headers?.referer || req.headers?.referrer),
      host: headerValue(req.headers?.host),
      protocol: req.protocol,
      content_length: res.getHeader('content-length') || null,
      query: req.query || null,
    };
    console.log(JSON.stringify(log));
  });

  return next();
}
