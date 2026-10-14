export function bearerToken(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

export function isPlatformAdministrator(auth) {
  return auth?.user?.is_platform_admin === true;
}
