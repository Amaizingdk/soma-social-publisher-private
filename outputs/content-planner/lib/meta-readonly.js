'use strict';

const API_ORIGIN = 'https://graph.facebook.com';
const API_VERSION = 'v26.0';
const PAGE_ID = '628094223731455';
const PAGE_NAME = 'SOMA Sauna Gus';
const INSTAGRAM_ID = '17841475009702608';
const INSTAGRAM_USERNAME = 'somasaunagus';
const REQUIRED_PERMISSIONS = Object.freeze({
  instagram_story: ['instagram_basic', 'instagram_content_publish'],
  facebook_page_feed: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
});

function sanitizeMetaError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) message = message.split(secret).join('[REDACTED]');
  }
  message = message.replace(/EA[A-Za-z0-9]{20,}/g, '[REDACTED]');
  return new Error(message);
}

async function requestMetaReadonly(options = {}) {
  const method = options.method === undefined ? 'GET' : options.method;
  if (method !== 'GET') throw new Error('Kun GET er tilladt til Meta-validering');

  const path = options.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Der kræves en relativ Meta-sti');
  }

  const token = options.token;
  if (typeof token !== 'string' || token.trim() === '') throw new Error('Meta-token mangler');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Meta GET fejlede (ingen HTTP-klient)');

  let response;
  try {
    response = await fetchImpl(`${API_ORIGIN}/${API_VERSION}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    sanitizeMetaError(error, [token]);
    throw new Error('Meta GET fejlede (netværk)');
  }

  if (!response || response.ok !== true) {
    const status = Number.isInteger(response?.status) ? response.status : 'ukendt';
    throw new Error(`Meta GET fejlede (HTTP ${status})`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`Meta GET fejlede (ugyldigt JSON, HTTP ${response.status})`);
  }
}

async function validateMetaConnection({ token, fetchImpl = globalThis.fetch } = {}) {
  const user = await requestMetaReadonly({
    path: '/me?fields=id,name',
    token,
    fetchImpl,
  });
  const page = await requestMetaReadonly({
    path: `/${PAGE_ID}?fields=id,name,instagram_business_account{id,username}`,
    token,
    fetchImpl,
  });

  const instagram = page?.instagram_business_account;
  if (
    typeof user?.id !== 'string'
    || user.id.trim() === ''
    || typeof user?.name !== 'string'
    || user.name.trim() === ''
    || page?.id !== PAGE_ID
    || page?.name !== PAGE_NAME
    || instagram?.id !== INSTAGRAM_ID
    || instagram?.username !== INSTAGRAM_USERNAME
  ) {
    throw new Error('Meta-identitet matcher ikke SOMA');
  }

  return {
    status: 'passed',
    userId: user?.id,
    userName: user?.name,
    pageId: page.id,
    pageName: page.name,
    instagramId: instagram.id,
    instagramUsername: instagram.username,
  };
}

function normalizedBookingUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Det forventede bookinglink er ugyldigt');
  }
  if (parsed.protocol !== 'https:') throw new Error('Bookinglinket skal bruge HTTPS');
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (hostname !== 'somasaunagus.dk') throw new Error('Bookinglinket skal pege på somasaunagus.dk');
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return `https://${hostname}${pathname}${parsed.search}`;
}

async function validateInstagramBioLink({
  token,
  expectedBookingUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  const expected = normalizedBookingUrl(expectedBookingUrl);
  const profile = await requestMetaReadonly({
    path: `/${INSTAGRAM_ID}?fields=id,username,website`,
    token,
    fetchImpl,
  });

  if (profile?.id !== INSTAGRAM_ID || profile?.username !== INSTAGRAM_USERNAME) {
    throw new Error('Instagram-kontoen matcher ikke SOMA');
  }

  let actual;
  try {
    actual = normalizedBookingUrl(profile?.website);
  } catch {
    throw new Error('Instagram bio-link mangler eller er ugyldigt');
  }
  if (actual !== expected) {
    throw new Error('Instagram bio-link matcher ikke bookinglinket');
  }

  let response;
  try {
    response = await fetchImpl(expectedBookingUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { Accept: 'text/html' },
    });
  } catch {
    throw new Error('Bookingsiden kan ikke åbnes');
  }
  if (!response || response.ok !== true) throw new Error('Bookingsiden kan ikke åbnes');

  return {
    status: 'passed',
    instagramId: profile.id,
    instagramUsername: profile.username,
    website: profile.website,
    bookingUrl: expectedBookingUrl,
  };
}

async function validateMetaPermissions({ token, deliveryType, fetchImpl = globalThis.fetch } = {}) {
  const required = REQUIRED_PERMISSIONS[deliveryType];
  if (!required) throw new Error(`Leveringstypen ${deliveryType || 'mangler'} er ikke tilladt`);
  const payload = await requestMetaReadonly({
    path: '/me/permissions',
    token,
    fetchImpl,
  });
  const granted = new Set((Array.isArray(payload?.data) ? payload.data : [])
    .filter((item) => item?.status === 'granted')
    .map((item) => item.permission));
  const missing = required.filter((permission) => !granted.has(permission));
  if (missing.length > 0) throw new Error(`Meta-permission mangler: ${missing.join(', ')}`);
  return { status: 'passed', deliveryType, permissions: [...required] };
}

async function validateMetaPreflight({
  token,
  deliveryType,
  instagramUserId,
  pageId,
  bookingUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!REQUIRED_PERMISSIONS[deliveryType]) {
    throw new Error(`Leveringstypen ${deliveryType || 'mangler'} er ikke tilladt`);
  }
  if (instagramUserId !== INSTAGRAM_ID || pageId !== PAGE_ID) {
    throw new Error('Meta-destinationerne matcher ikke de faste SOMA-IDer');
  }
  await validateMetaConnection({ token, fetchImpl });
  await validateMetaPermissions({ token, deliveryType, fetchImpl });
  if (deliveryType === 'instagram_story') {
    await validateInstagramBioLink({ token, expectedBookingUrl: bookingUrl, fetchImpl });
  }
  return { status: 'passed', deliveryType };
}

module.exports = {
  REQUIRED_PERMISSIONS,
  requestMetaReadonly,
  sanitizeMetaError,
  validateInstagramBioLink,
  validateMetaConnection,
  validateMetaPermissions,
  validateMetaPreflight,
};
