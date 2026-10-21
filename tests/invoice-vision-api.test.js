'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'invoice-vision.js'), 'utf8');
const image = { data_url: 'data:image/png;base64,aGVsbG8=', mime_type: 'image/png' };

async function call({ env = {}, body = image, auth = 'Bearer test-session', validSession = true, providerError, actualModel } = {}) {
  const calls = { verification: 0, requests: [] };
  const module = { exports: {} };
  const context = {
    module, process: { env }, console: { error() {} },
    fetch: async (url, options) => {
      calls.verification++;
      assert.equal(url, 'https://gnfqlfxuagcgjztaueot.supabase.co/auth/v1/user');
      assert.equal(options.headers.Authorization, auth);
      return { ok: validSession };
    },
    require(name) {
      assert.equal(name, 'openai');
      return class {
        constructor(options) {
          calls.client = options;
          this.responses = { create: async request => {
            calls.requests.push(request);
            if (providerError) throw providerError;
            return { model: actualModel || request.model, output_text: '{"lines":[],"total_gross":12.34}' };
          } };
        }
      };
    }
  };
  vm.runInNewContext(source, context);
  const response = {
    status(code) { this.code = code; return this; },
    json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; }
  };
  await module.exports({ method: 'POST', headers: { authorization: auth }, body }, response);
  return { calls, response };
}

test('direct OpenAI keeps its provider, configured model and returned model provenance', async () => {
  const { calls, response } = await call({ env: { OPENAI_API_KEY: 'test-direct', OPENAI_INVOICE_MODEL: 'configured-direct' }, actualModel: 'actual-direct' });
  assert.equal(response.code, 200);
  assert.equal(calls.client.apiKey, 'test-direct');
  assert.equal(calls.client.baseURL, undefined);
  assert.equal(calls.requests[0].model, 'configured-direct');
  assert.equal(response.body.provider, 'openai-vision');
  assert.equal(response.body.model, 'actual-direct');
});

test('Gateway forwards the original image and strict schema and returns actual provenance', async () => {
  const { calls, response } = await call({ env: { AI_GATEWAY_API_KEY: 'test-gateway' }, actualModel: 'openai/gpt-6-luna-snapshot' });
  assert.equal(response.code, 200);
  assert.equal(calls.client.apiKey, 'test-gateway');
  assert.equal(calls.client.baseURL, 'https://ai-gateway.vercel.sh/v1');
  const request = calls.requests[0];
  assert.equal(request.model, 'openai/gpt-6-luna');
  assert.equal(request.store, false);
  assert.equal(request.input[0].content[1].type, 'input_image');
  assert.equal(request.input[0].content[1].image_url, image.data_url);
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.equal(response.body.provider, 'vercel-ai-gateway');
  assert.equal(response.body.model, 'openai/gpt-6-luna-snapshot');
  assert.equal(response.body.invoice.total_gross, 12.34);
});

test('Gateway supports a configured model and forwards the original PDF', async () => {
  const body = { file_data: 'data:application/pdf;base64,aGVsbG8=', file_name: 'invoice.pdf', mime_type: 'application/pdf' };
  const { calls, response } = await call({ env: { AI_GATEWAY_API_KEY: 'test-gateway', AI_GATEWAY_INVOICE_MODEL: 'openai/gpt-5-mini' }, body });
  assert.equal(response.code, 200);
  assert.equal(calls.requests[0].model, 'openai/gpt-5-mini');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.requests[0].input[0].content[1])), {
    type: 'input_file', filename: body.file_name, file_data: body.file_data
  });
});

test('an existing direct OpenAI key takes precedence over Gateway', async () => {
  const { calls, response } = await call({ env: { OPENAI_API_KEY: 'test-direct', AI_GATEWAY_API_KEY: 'test-gateway' } });
  assert.equal(calls.client.apiKey, 'test-direct');
  assert.equal(calls.client.baseURL, undefined);
  assert.equal(calls.requests[0].model, 'gpt-6-luna');
  assert.equal(response.body.provider, 'openai-vision');
});

test('an OIDC token alone does not activate AI or get used as a credential', async () => {
  const { calls, response } = await call({ env: { VERCEL_OIDC_TOKEN: 'test-unused-oidc' } });
  assert.equal(response.code, 503);
  assert.equal(response.body.error, 'vision_not_configured');
  assert.equal(calls.client, undefined);
});

for (const [label, options, error, verification] of [
  ['no login', { auth: '' }, 'login_required', 0],
  ['invalid session', { validSession: false }, 'invalid_session', 1]
]) test(`Gateway cannot be called with ${label}`, async () => {
  const { calls, response } = await call({ ...options, env: { AI_GATEWAY_API_KEY: 'test-gateway' } });
  assert.equal(response.code, 401);
  assert.equal(response.body.error, error);
  assert.equal(calls.verification, verification);
  assert.equal(calls.client, undefined);
});

test('Gateway quota or provider failure returns an error for the existing OCR fallback', async () => {
  const { calls, response } = await call({ env: { AI_GATEWAY_API_KEY: 'test-gateway' }, providerError: new Error('budget exceeded') });
  assert.equal(calls.requests.length, 1);
  assert.equal(response.code, 502);
  assert.equal(response.body.error, 'vision_provider_error');
  assert.equal(response.body.detail, 'budget exceeded');
});

test('missing documents are rejected before an AI request', async () => {
  const { calls, response } = await call({ env: { AI_GATEWAY_API_KEY: 'test-gateway' }, body: {} });
  assert.equal(response.code, 400);
  assert.equal(response.body.error, 'document_required');
  assert.equal(calls.client, undefined);
});

test('oversized documents are rejected before an AI request', async () => {
  const { calls, response } = await call({ env: { AI_GATEWAY_API_KEY: 'test-gateway' }, body: { ...image, data_url: 'data:image/png;base64,' + 'a'.repeat(16 * 1024 * 1024 + 4) } });
  assert.equal(response.code, 413);
  assert.equal(response.body.error, 'document_too_large');
  assert.equal(calls.client, undefined);
});
