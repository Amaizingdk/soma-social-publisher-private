'use strict';

const { sanitizeMetaError, validateMetaPreflight } = require('./meta-readonly');

const GRAPH_VERSION = 'v26.0';

function requireToken(token) {
  if (typeof token !== 'string' || token.trim() === '') throw new Error('Meta-token mangler');
  return token;
}

function requireEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/') || endpoint.startsWith('//')) {
    throw new Error('Der kræves et relativt Meta-endpoint');
  }
  return endpoint;
}

function requireAllowedDelivery(deliveryType) {
  if (!['instagram_story', 'facebook_page_feed'].includes(deliveryType)) {
    throw new Error(`Leveringstypen ${deliveryType || 'mangler'} er ikke tilladt`);
  }
  return deliveryType;
}

function safeGraphError(label, response, payload) {
  const status = Number.isInteger(response?.status) ? response.status : 'ukendt';
  const code = Number.isInteger(payload?.error?.code) || typeof payload?.error?.code === 'string'
    ? `, code ${payload.error.code}`
    : '';
  return new Error(`${label} fejlede (HTTP ${status}${code})`);
}

async function graphPost({ endpoint, params, token, fetchImpl = globalThis.fetch }) {
  const body = new URLSearchParams({ ...params, access_token: requireToken(token) });
  requireEndpoint(endpoint);
  let response;
  try {
    response = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (error) {
    throw sanitizeMetaError(new Error('Meta POST fejlede (netværk)'), [token, error?.message]);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) throw safeGraphError('Meta POST', response, payload);
  return payload;
}

async function graphGet({ endpoint, token, fetchImpl = globalThis.fetch }) {
  requireEndpoint(endpoint);
  requireToken(token);
  let response;
  try {
    response = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}${endpoint}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw sanitizeMetaError(new Error('Meta GET fejlede (netværk)'), [token, error?.message]);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) throw safeGraphError('Meta GET', response, payload);
  return payload;
}

function createMetaWriteAdapter({
  token,
  instagramUserId,
  pageId,
  bookingUrl,
  fetchImpl = globalThis.fetch,
  preflightValidator = validateMetaPreflight,
  waitImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxStatusChecks = 10,
  statusPollMs = 1_000,
}) {
  async function waitForContainerFinished(containerId) {
    for (let attempt = 0; attempt < maxStatusChecks; attempt += 1) {
      const payload = await graphGet({
        endpoint: `/${containerId}?fields=status_code`,
        token,
        fetchImpl,
      });
      if (payload.status_code === 'FINISHED') return;
      if (payload.status_code === 'ERROR' || payload.status_code === 'EXPIRED') {
        throw new Error(`Instagram Story-container fejlede med status ${payload.status_code}`);
      }
      if (payload.status_code !== 'IN_PROGRESS') {
        throw new Error(`Ukendt Instagram Story-status: ${payload.status_code || 'mangler'}`);
      }
      if (attempt < maxStatusChecks - 1) await waitImpl(statusPollMs);
    }
    throw new Error('Instagram Story-container timeout');
  }

  return {
    async preflight(item) {
      const deliveryType = requireAllowedDelivery(item?.deliveryType);
      requireToken(token);
      try {
        await preflightValidator({
          token,
          deliveryType,
          instagramUserId,
          pageId,
          bookingUrl,
          fetchImpl,
        });
      } catch (error) {
        throw sanitizeMetaError(error, [token]);
      }
      return { status: 'passed', deliveryType };
    },
    async publish(item) {
      if (!item || !item.deliveryType || !item.imageUrl) throw new Error('Meta-levering mangler deliveryType eller imageUrl');
      requireAllowedDelivery(item.deliveryType);
      requireToken(token);
      if (item.deliveryType === 'instagram_story') {
        if (instagramUserId !== '17841475009702608') throw new Error('Instagram-bruger-id matcher ikke SOMA');
        const container = await graphPost({
          endpoint: `/${instagramUserId}/media`,
          params: { media_type: 'STORIES', image_url: item.imageUrl },
          token,
          fetchImpl,
        });
        if (!container.id) throw new Error('Meta returnerede ingen Instagram creation_id');
        await waitForContainerFinished(container.id);
        const published = await graphPost({
          endpoint: `/${instagramUserId}/media_publish`,
          params: { creation_id: container.id },
          token,
          fetchImpl,
        });
        return { providerId: published.id || container.id };
      }
      if (item.deliveryType === 'facebook_page_feed') {
        if (pageId !== '628094223731455') throw new Error('Facebook Page-id matcher ikke SOMA');
        if (typeof item.caption !== 'string' || item.caption.trim() === '') throw new Error('Facebook Page-opslag mangler caption');
        const published = await graphPost({
          endpoint: `/${pageId}/photos`,
          params: { url: item.imageUrl, caption: item.caption },
          token,
          fetchImpl,
        });
        return { providerId: published.id || published.post_id || null };
      }
      throw new Error(`Leveringstypen ${item.deliveryType} er ikke tilladt`);
    },
  };
}

module.exports = { createMetaWriteAdapter, graphPost, graphGet };
