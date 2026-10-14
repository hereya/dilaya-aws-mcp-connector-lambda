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
// Before all that, on EVERY site, closed or not, a cookie-less request for a
// path no Dilaya site serves gets a bare 404 — zero Lambda:
//  - a dot-path (/.env, /.git/…; /.well-known/* excepted) — t_closed_site_dotfile_404,
//    widened by t_dotfile_404_all_sites: on 2026-10-06 a .env scanner followed
//    347 login redirects in 3 s and saturated the auth Lambda, on a site its
//    OWN code closes, which the auth flag never sees;
//  - a server-side SCRIPT path (.php/.phpN/.phtml/.asp/.aspx/.jsp/.jspx/.cgi/
//    .pl/.cfm, any case; /.well-known/ included) — t_scanner_ext_404: on
//    2026-10-12 a scanner probed 282 PHP paths in 3 min; each redirect carried
//    a DISTINCT return_url, so the login page's 60 s cache (keyed on the query
//    string) absorbed none of them and every probe ran the auth Lambda until
//    the 60/min brake refused the rest. Sites are served by JS handlers: 14 days
//    of edge logs (172 677 requests, 61 000 on such paths) hold not one answered 200.
// The return path rides in the FRAGMENT (/auth/login#r=<path>), never the
// query — t_login_return_fragment: four real RateGuardAlarm firings in 23 h
// (12-13/10) had the same shape, a scanner probing hundreds of generic paths
// (/dashboard, /form/, /wrangler.toml, /values.yaml…) that no edge rule can
// tell from a real page; each 302 carried a distinct ?return_url, so each
// was a distinct cache key and the login page's 60 s cache absorbed none —
// up to 174 origin renders a minute, 32 of the auth Lambda's 50 shared slots.
// A fragment never reaches the server nor the cache: the anonymous login
// page is ONE entry per (host, language, cookies) and a scanner on N paths
// costs ONE render a minute. The page's script copies #r= into the hidden
// return_url field; safeReturnUrl still validates it at the POST.
//
// Both 404 rules run on a DECODED copy of the path (t_edge_404_percent_bypass,
// 0.1.109): they tested request.uri as sent, so /%2Eenv showed the regex no
// "." and earned a login redirect (one render each) while the origin decodes
// and serves the same path — a scanner did exactly that on 13/10. Two passes,
// as deep as the origin chain decodes (API Gateway, then the app); pair by
// pair, so a malformed escape elsewhere cannot switch the decoding off; and
// only for these tests — routing keeps request.uri untouched.
// The QUERY form is folded into the fragment at the edge too (t_login_query_to_fragment,
// 0.1.110): the fragment above only covers the 302s the platform issues, and a
// site closed by its OWN code (rap-connect, the legacy enforce:false contract)
// kept redirecting to /auth/login?return_url=<path> — 48 of its 50 login renders
// after 0.1.108 still carried the query, 11 auth-Lambda runs in one minute on
// 14/10 05:47Z. An anonymous GET/HEAD of /auth/login with return_url is answered
// 302 to /auth/login#r=<path> (other params kept — the OTP back link carries
// ?email=), path filtered to a relative one as safeReturnUrl would, else bare.
// A visitor with a cookie, or a POST, passes untouched (the auth Lambda's job).
//
// This is a PRESENCE check — a CloudFront Function has no crypto — so it is
// the UX and the saving (no Lambda for an anonymous hit), never the guard:
// the frontend authorizer at the origin verifies the cookie and refuses
// anonymous dynamic pages. Static sections (served from S3, never reaching
// the authorizer) are what this branch alone protects; the cookie's lifetime
// is the token's (auth-lambda idTokenMaxAge), so "present" is "not expired"
// for an honest browser.
export const LOGIN_GATE_BRANCH = `  var ck = request.cookies || {};
  var anon = !ck['dilaya_id_token'] && !ck['hereya_id_token'] && !ck['dilaya_agent'];
  var du = uri;
  for (var d = 0; d < 2; d++) du = du.replace(/%[0-9a-fA-F]{2}/g, function (m) { try { return decodeURIComponent(m); } catch (x) { return m; } });
  if (anon && (/\\/\\.(?!well-known(\\/|$))/.test(du) || /\\.(php\\d?|phtml|aspx?|jspx?|cgi|pl|cfm)$/i.test(du))) {
    return { statusCode: 404, statusDescription: 'Not Found', headers: { 'cache-control': { value: 'no-store' } } };
  }
  var mth = request.method;
  if (anon && uri === '/auth/login' && request.querystring.return_url && (mth === 'GET' || mth === 'HEAD')) {
    var rp = '';
    try { rp = decodeURIComponent(request.querystring.return_url.value); } catch (x) { rp = ''; }
    if (rp.length > 2048 || rp.charAt(0) !== '/' || rp.charAt(1) === '/' || rp.indexOf('\\\\') >= 0) rp = '';
    delete request.querystring.return_url;
    return {
      statusCode: 302,
      statusDescription: 'Found',
      headers: {
        'location': { value: '/auth/login' + qsOf(request) + (rp ? '#r=' + encodeURIComponent(rp) : '') },
        'cache-control': { value: 'no-store' }
      }
    };
  }
  if (e.auth && uri !== '/auth' && uri.indexOf('/auth/') !== 0
      && uri !== '/static' && uri.indexOf('/static/') !== 0) {
    var pub = false;
    if (e.pub) {
      for (var q = 0; q < e.pub.length; q++) {
        var pp = e.pub[q];
        if (pp === '/' ? uri === '/' : (uri === pp || uri.indexOf(pp + '/') === 0)) { pub = true; break; }
      }
    }
    if (!pub && anon) {
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
          'location': { value: '/auth/login#r=' + encodeURIComponent(uri + qsOf(request)) },
          'cache-control': { value: 'no-store' }
        }
      };
    }
  }`;
