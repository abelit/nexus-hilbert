// The trigger option's action payloads.
//
// THESE SHAPES ARE CANTOR'S, because the option column is an adopted JSON
// document and the service keeps keys it does not understand. The webhook
// editor and the notification editor both write this vocabulary, so a later
// dispatcher can read the same rows cantor wrote.
//
// SECRETS ARE NOT IN THE FORM STATE. The backend encrypts every value under
// `webhooks.authorization` and never returns it; the editor therefore starts
// those fields empty and means "leave the stored credential" when they are.

export type WebhookAuthType = 'none' | 'BasicAuth' | 'Bearer' | 'APIKey' | 'OAuth2.0';

export type WebhookAuthorization = {
  type?: string;
  username?: string;
  password?: string;
  token?: string;
  key?: string;
  value?: string;
  client_id?: string;
  client_secret?: string;
  authorization_base_url?: string;
  token_url?: string;
  redirect_url?: string;
  scope?: string;
  [key: string]: unknown;
};

export type WebhookConfig = {
  method: string;
  url: string;
  parameters: Record<string, string>;
  body: string;
  headers: Record<string, string>;
  authorization?: WebhookAuthorization;
  /** Outside the encrypted object so the type survives a read. */
  auth_type?: WebhookAuthType | string;
};

export type KeyValue = { key: string; value: string };

export const WEBHOOK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const WEBHOOK_AUTH_TYPES: ReadonlyArray<{
  value: WebhookAuthType;
  zh: string;
  en: string;
}> = [
  { value: 'none', zh: '无认证', en: 'None' },
  { value: 'BasicAuth', zh: 'Basic 认证', en: 'Basic auth' },
  { value: 'Bearer', zh: 'Bearer Token', en: 'Bearer token' },
  { value: 'APIKey', zh: 'API Key', en: 'API key' },
  { value: 'OAuth2.0', zh: 'OAuth 2.0', en: 'OAuth 2.0' },
];

export const NOTIFY_METHODS: ReadonlyArray<{ value: string; zh: string; en: string }> = [
  { value: 'email', zh: '邮件', en: 'Email' },
  { value: 'wechatApp', zh: '企业微信', en: 'WeCom' },
  { value: 'dingdingApp', zh: '钉钉', en: 'DingTalk' },
  { value: 'feishuApp', zh: '飞书', en: 'Feishu' },
];

export function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(recordOf(value))) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

export function isAuthType(value: unknown): value is WebhookAuthType {
  return WEBHOOK_AUTH_TYPES.some((item) => item.value === value);
}

/** Normalise an option's webhook block into the editor's state. */
export function webhookConfigOf(value: unknown): WebhookConfig {
  const raw = recordOf(value);
  const authorization = recordOf(raw.authorization);
  const authorizationType = isAuthType(authorization.type)
    ? authorization.type
    : isAuthType(raw.auth_type)
      ? raw.auth_type
      : 'none';
  const body = raw.body;
  return {
    method: typeof raw.method === 'string' && raw.method ? raw.method : 'GET',
    url: typeof raw.url === 'string' ? raw.url : '',
    parameters: stringRecord(raw.parameters),
    headers: stringRecord(raw.headers),
    body:
      typeof body === 'string'
        ? body
        : body == null
          ? ''
          : JSON.stringify(body, null, 2),
    authorization: { ...authorization, type: authorizationType },
    auth_type: authorizationType,
  };
}

/** The authorization values the editor is allowed to send, minus empty ones. */
export function authorizationValues(auth: WebhookAuthorization | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(auth ?? {})) {
    if (key === 'type') continue;
    if (typeof value === 'string' && value.trim()) out[key] = value;
  }
  return out;
}
