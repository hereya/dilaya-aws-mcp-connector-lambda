// The LOGIN REQUIRED branch of the apphost router (t_frontend_auth_default,
// deploy-pkg >= 0.1.73), spliced into router-function.ts's source right after
// the stop/redirect branches and before any routing. Kept apart only for the
// 220-line rule; it is one function with the rest, so read them together.
//
// Value flag `auth` = 1: the PLATFORM closes the site. A visitor with no
// session cookie is sent to /auth/login (return_url = where they were) —
// /api/* answers 401 JSON instead, an XHR has nowhere to be redirected to.
// Exempt: /auth/* (the login flow itself), /static/* (assets — the login
// page's own logo lives there), and the app's declared PUBLIC prefixes
// (value flag `pub`; '/' means the root page only, never the whole site).
//
// This is a PRESENCE check — a CloudFront Function has no crypto — so it is
// the UX and the saving (no Lambda for an anonymous hit), never the guard:
// the frontend authorizer at the origin verifies the cookie and refuses
// anonymous dynamic pages. Static sections (served from S3, never reaching
// the authorizer) are what this branch alone protects; the cookie's lifetime
// is the token's (auth-lambda idTokenMaxAge), so "present" is "not expired"
// for an honest browser.
export const LOGIN_GATE_BRANCH = `  if (e.auth && uri !== '/auth' && uri.indexOf('/auth/') !== 0
      && uri !== '/static' && uri.indexOf('/static/') !== 0) {
    var pub = false;
    if (e.pub) {
      for (var q = 0; q < e.pub.length; q++) {
        var pp = e.pub[q];
        if (pp === '/' ? uri === '/' : (uri === pp || uri.indexOf(pp + '/') === 0)) { pub = true; break; }
      }
    }
    var ck = request.cookies || {};
    if (!pub && !ck['dilaya_id_token'] && !ck['hereya_id_token'] && !ck['dilaya_agent']) {
      if (uri === '/api' || uri.indexOf('/api/') === 0) {
        return {
          statusCode: 401,
          statusDescription: 'Unauthorized',
          headers: {
            'content-type': { value: 'application/json; charset=utf-8' },
            'cache-control': { value: 'no-store' }
          },
          body: '{"error":"login_required"}'
        };
      }
      return {
        statusCode: 302,
        statusDescription: 'Found',
        headers: {
          'location': { value: '/auth/login?return_url=' + encodeURIComponent(uri + qsOf(request)) },
          'cache-control': { value: 'no-store' }
        }
      };
    }
  }`;
