export const OPERATOR_PAGE_COMMON_JS: string = `
(function () {
  'use strict';

  async function readPayload(response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json().catch(() => null);
    }
    return response.text().catch(() => '');
  }

  function buildErrorMessage(response, payload) {
    if (payload && typeof payload === 'object' && typeof payload.error === 'string' && payload.error.length > 0) {
      return payload.error;
    }
    if (typeof payload === 'string' && payload.length > 0) {
      return payload;
    }
    return response.statusText || ('HTTP ' + response.status);
  }

  async function fetchJson(url, options) {
    const init = Object.assign({}, options || {});
    const method = typeof init.method === 'string' ? init.method.toUpperCase() : 'GET';
    if (init.cache === undefined && method === 'GET') {
      init.cache = 'no-store';
    }

    const response = await fetch(url, init);
    const payload = await readPayload(response);
    if (!response.ok) {
      const error = new Error(buildErrorMessage(response, payload));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function postJson(url, body, options) {
    const init = Object.assign({}, options || {});
    const headers = Object.assign({}, init.headers || {});
    headers['Content-Type'] = 'application/json';
    init.method = init.method || 'POST';
    init.headers = headers;
    init.body = JSON.stringify(body === undefined ? {} : body);
    return fetchJson(url, init);
  }

  window.operatorPage = Object.freeze({
    fetchJson,
    postJson,
    stopAll: function stopAll() {
      return postJson('/api/stop', {});
    },
  });
})();
`;

export function getOperatorPageCommonScriptTag(): string {
  return `<script src="/operator-page-common.js"></script>`;
}
