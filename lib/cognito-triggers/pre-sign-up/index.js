// Pre-sign-up trigger — auto-confirms users added via AdminCreateUser /
// passwordless sign-in. Multi-tenant: pool-agnostic, reused across every
// per-app pool provisioned by `enable-auth`.
exports.handler = async (event) => {
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = false;
  return event;
};
