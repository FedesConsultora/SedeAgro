const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function prepareCompanyRegistration(input) {
  const organizationName = typeof input?.organizationName === 'string'
    ? input.organizationName.trim() : '';
  const fullName = typeof input?.fullName === 'string' ? input.fullName.trim() : '';
  const slug = typeof input?.slug === 'string' ? input.slug.trim() : '';
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = input?.password;
  if (organizationName.length < 2 || organizationName.length > 180 ||
      fullName.length < 2 || fullName.length > 180) {
    throw new Error('Revisá el nombre de la empresa y el nombre completo.');
  }
  if (slug.length < 3 || slug.length > 90 || !/^[a-z0-9-]+$/.test(slug)) {
    throw new Error('El identificador de empresa debe usar letras minúsculas, números o guiones.');
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Ingresá un email válido para registrar la empresa.');
  }
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('La contraseña debe tener al menos 12 caracteres.');
  }
  // Strong password enforcement remains on the backend. Never persist input
  // or request bodies to LocalStorage, query params, analytics or logs.
  return Object.freeze({ organizationName, slug, fullName, email, password, planCode: 'starter' });
}

export function verifyRegisteredCompany(response, requested) {
  const user = response?.user;
  const tenant = response?.tenant;
  const membership = response?.membership;
  if (!response || typeof response !== 'object' || Array.isArray(response) ||
      Object.hasOwn(response, 'token') ||
      !UUID.test(user?.id || '') || !UUID.test(tenant?.id || '') ||
      !UUID.test(membership?.id || '') ||
      user.email?.trim()?.toLowerCase() !== requested?.email ||
      user.fullName !== requested?.fullName ||
      tenant.name !== requested?.organizationName || tenant.slug !== requested?.slug ||
      membership.roleCode !== 'tenant_admin' ||
      membership.status !== 'active' ||
      !Array.isArray(response.entitlements) ||
      !response.entitlements.every(value => typeof value === 'string')) {
    throw new Error('El servidor no confirmó la empresa y el administrador solicitados.');
  }
  return response;
}

// POST /auth/register-tenant has no client request id. An HTTP 5xx, lost
// response or invalid 2xx receipt may have followed a successful transaction:
// never issue another POST from this form in that ambiguous state.
export function createCompanyRegistrationGate() {
  let state = 'idle';
  let current = null;
  let sequence = 0;
  return Object.freeze({
    acquire(input) {
      if (state !== 'idle') return null;
      const body = prepareCompanyRegistration(input);
      const ticket = Object.freeze({ id: ++sequence, body });
      current = ticket;
      state = 'pending';
      return ticket;
    },
    isCurrent(ticket) { return Boolean(ticket && state === 'pending' && current === ticket); },
    isPending() { return state === 'pending'; },
    isBlocked() { return state !== 'idle'; },
    finish(ticket, result) {
      if (current !== ticket || state !== 'pending') return false;
      if (result === 'rejected') {
        current = null;
        state = 'idle';
      } else if (result === 'confirmed' || result === 'uncertain') {
        state = result;
      } else {
        throw new Error('Resultado de registro inválido.');
      }
      return true;
    },
    reset() { ++sequence; current = null; state = 'idle'; }
  });
}
