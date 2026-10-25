const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// This is a UI-level, same-tab request fence, not a server authentication
// control. Passwords exist only in the current component/gate memory and must
// never be copied to browser storage, URLs, logs or error messages.
function requireCredentials(input) {
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = input?.password;
  if (!email || !email.includes('@') || typeof password !== 'string' || !password) {
    throw new Error('Ingresá email y contraseña para continuar.');
  }
  return Object.freeze({ email, password });
}

export function verifyTenantChoices(reply) {
  const members = reply?.memberships;
  if (reply?.requiresTenantSelection !== true || !Array.isArray(members) ||
      !members.length || members.length > 100) {
    throw new Error('El servidor no confirmó una lista válida de empresas.');
  }
  const ids = new Set();
  const slugs = new Set();
  return Object.freeze(members.map(member => {
    if (!member || !UUID.test(member.tenantId || '') ||
        typeof member.tenantSlug !== 'string' ||
        !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(member.tenantSlug) ||
        typeof member.tenantName !== 'string' || !member.tenantName.trim() ||
        typeof member.roleCode !== 'string' || !member.roleCode.trim() ||
        ids.has(member.tenantId) || slugs.has(member.tenantSlug)) {
      throw new Error('El servidor devolvió empresas inconsistentes.');
    }
    ids.add(member.tenantId);
    slugs.add(member.tenantSlug);
    return Object.freeze({
      tenantId: member.tenantId, tenantSlug: member.tenantSlug,
      tenantName: member.tenantName, roleCode: member.roleCode
    });
  }));
}

export function verifyLoginSession(reply, email, selected = null) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply) ||
      reply.requiresTenantSelection === true ||
      !UUID.test(reply.user?.id || '') ||
      typeof reply.user?.email !== 'string' ||
      reply.user.email.trim().toLowerCase() !== email ||
      !UUID.test(reply.tenant?.id || '') ||
      !UUID.test(reply.membership?.id || '') ||
      typeof reply.membership.roleCode !== 'string' || !reply.membership.roleCode.trim() ||
      !Array.isArray(reply.entitlements) ||
      !reply.entitlements.every(x => typeof x === 'string') ||
      (selected && (reply.tenant.id !== selected.tenantId ||
        reply.tenant.slug !== selected.tenantSlug ||
        reply.membership.roleCode !== selected.roleCode))) {
    throw new Error('El servidor no confirmó la identidad o la empresa solicitada.');
  }
  return reply;
}

// A first response with multiple active memberships starts a challenge, not
// an authenticated session. Only one of those exact choices can be submitted,
// using the same immutable credential pair as the original attempt.
export function createLoginAttemptGate() {
  let phase = 'idle';
  let serial = 0;
  let active = null;
  let credentials = null;
  let members = null;
  let selection = null;
  const reset = () => {
    serial++;
    active = null;
    credentials = null;
    members = null;
    selection = null;
    phase = 'idle';
  };
  return Object.freeze({
    begin(form) {
      if (phase !== 'idle') return null;
      credentials = requireCredentials(form);
      const ticket = Object.freeze({ id: ++serial, kind: 'initial',
        body: credentials });
      active = ticket;
      phase = 'pending';
      return ticket;
    },
    choose(slug) {
      if (phase !== 'choices' || !members) return null;
      const member = members.find(m => m.tenantSlug === slug);
      if (!member) return null;
      selection = member;
      const ticket = Object.freeze({ id: ++serial, kind: 'selected',
        body: Object.freeze({ ...credentials, tenantSlug: member.tenantSlug }) });
      active = ticket;
      phase = 'pending';
      return ticket;
    },
    isCurrent(ticket) { return Boolean(ticket && phase === 'pending' && active === ticket); },
    busy() { return phase === 'pending'; },
    complete(ticket, reply) {
      if (!ticket || active !== ticket || phase !== 'pending') return null;
      if (reply?.requiresTenantSelection === true) {
        if (ticket.kind !== 'initial') {
          throw new Error('La selección de empresa cambió. Volvé a ingresar.');
        }
        const choices = verifyTenantChoices(reply);
        members = choices;
        phase = 'choices';
        active = null;
        return { kind: 'choices', memberships: choices };
      }
      const session = verifyLoginSession(reply, credentials.email,
        ticket.kind === 'selected' ? selection : null);
      phase = 'confirmed';
      active = null;
      return { kind: 'session', session };
    },
    fail(ticket) {
      if (!ticket || active !== ticket || phase !== 'pending') return false;
      active = null;
      if (ticket.kind === 'selected') {
        phase = 'choices';
        selection = null;
      } else {
        reset();
      }
      return true;
    },
    reset,
    phase() { return phase; }
  });
}
