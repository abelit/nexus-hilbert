import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { Textarea } from '@/components/ui/Textarea';
import { useI18n } from '@/i18n/locale';

import {
  WEBHOOK_AUTH_TYPES,
  WEBHOOK_METHODS,
  authorizationValues,
  type KeyValue,
  type WebhookAuthType,
  type WebhookConfig,
} from './types';

const toEntries = (record: Record<string, string>): KeyValue[] =>
  Object.entries(record).map(([key, value]) => ({ key, value }));

const toRecord = (rows: KeyValue[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    if (key.trim()) out[key.trim()] = value;
  }
  return out;
};

/**
 * The webhook half of a trigger action.
 *
 * The editor writes cantor's `WebhookConfig`: method + url + parameters +
 * headers + body + authorization. Parameters and headers stay as working rows
 * locally so an empty key does not disappear while it is being typed, then are
 * serialized into the option document on every change.
 */
export function TriggerWebhookEditor({
  value,
  onChange,
  hasStoredAuth,
  disabled = false,
}: {
  value: WebhookConfig;
  onChange(next: WebhookConfig): void;
  hasStoredAuth: boolean;
  disabled?: boolean;
}) {
  const { tr } = useI18n();
  const [paramRows, setParamRows] = useState<KeyValue[]>(() => toEntries(value.parameters));
  const [headerRows, setHeaderRows] = useState<KeyValue[]>(() => toEntries(value.headers));
  const [lastKV, setLastKV] = useState(() =>
    JSON.stringify([value.parameters, value.headers]),
  );

  const currentKV = JSON.stringify([value.parameters, value.headers]);
  if (currentKV !== lastKV) {
    setParamRows(toEntries(value.parameters));
    setHeaderRows(toEntries(value.headers));
    setLastKV(currentKV);
  }

  const patch = (next: Partial<WebhookConfig>) => onChange({ ...value, ...next });

  const authType: WebhookAuthType = useMemo(() => {
    const found = WEBHOOK_AUTH_TYPES.find(
      (item) => item.value === (value.auth_type ?? value.authorization?.type),
    );
    return found?.value ?? (hasStoredAuth ? 'BasicAuth' : 'none');
  }, [hasStoredAuth, value.auth_type, value.authorization?.type]);
  const auth = value.authorization ?? {};

  const patchAuth = (next: Record<string, string>) =>
    patch({ authorization: { ...auth, ...next, type: authType } });

  const changeAuthType = (next: WebhookAuthType) =>
    patch({ auth_type: next, authorization: { type: next } });

  const changeRows = (kind: 'parameters' | 'headers', rows: KeyValue[]) => {
    const record = toRecord(rows);
    const next = { ...value, [kind]: record };
    setLastKV(JSON.stringify([next.parameters, next.headers]));
    if (kind === 'parameters') setParamRows(rows);
    else setHeaderRows(rows);
    onChange(next);
  };

  const renderRows = (
    rows: KeyValue[],
    onRows: (next: KeyValue[]) => void,
    labels: { key: string; value: string },
  ) => (
    <div className="space-y-1.5">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            value={row.key}
            placeholder={labels.key}
            aria-label={labels.key}
            disabled={disabled}
            onChange={(event) =>
              onRows(rows.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)))
            }
            className="h-8 min-w-0 flex-1"
          />
          <Input
            value={row.value}
            placeholder={labels.value}
            aria-label={labels.value}
            disabled={disabled}
            onChange={(event) =>
              onRows(rows.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))
            }
            className="h-8 min-w-0 flex-1 font-mono"
          />
          <Button
            variant="plain"
            size="sm"
            type="button"
            onClick={() => onRows(rows.filter((_, i) => i !== index))}
            disabled={disabled}
            aria-label={tr('删除这一行', 'Delete this row')}
            className="inline-flex size-7 shrink-0 items-center justify-center p-0 text-text-faint hover:text-red-500"
          >
            <Trash2 size={12} aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => onRows([...rows, { key: '', value: '' }])}
        disabled={disabled}
        className="inline-flex items-center gap-1"
      >
        <Plus size={12} aria-hidden="true" />
        {tr('新增一行', 'Add row')}
      </Button>
    </div>
  );

  const authFields = () => {
    if (authType === 'none') {
      return (
        <p className="text-[11px] text-text-muted">
          {hasStoredAuth
            ? tr('保存时清除已存凭据。', 'Saving with “None” clears the stored credential.')
            : tr('不发送认证信息。', 'No authentication is sent.')}
        </p>
      );
    }
    if (authType === 'BasicAuth') {
      return (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input
            value={auth.username ?? ''}
            placeholder={tr('用户名', 'Username')}
            aria-label={tr('认证用户名', 'Auth username')}
            disabled={disabled}
            onChange={(event) => patchAuth({ username: event.target.value })}
          />
          <Input
            type="password"
            value={auth.password ?? ''}
            placeholder={tr('密码', 'Password')}
            aria-label={tr('认证密码', 'Auth password')}
            disabled={disabled}
            onChange={(event) => patchAuth({ password: event.target.value })}
          />
        </div>
      );
    }
    if (authType === 'Bearer') {
      return (
        <Input
          value={auth.token ?? ''}
          placeholder="Token"
          aria-label={tr('Bearer Token', 'Bearer token')}
          disabled={disabled}
          onChange={(event) => patchAuth({ token: event.target.value })}
        />
      );
    }
    if (authType === 'APIKey') {
      return (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input
            value={auth.key ?? ''}
            placeholder="Key"
            aria-label={tr('API Key 名称', 'API key name')}
            disabled={disabled}
            onChange={(event) => patchAuth({ key: event.target.value })}
          />
          <Input
            value={auth.value ?? ''}
            placeholder="Value"
            aria-label={tr('API Key 值', 'API key value')}
            disabled={disabled}
            onChange={(event) => patchAuth({ value: event.target.value })}
          />
        </div>
      );
    }
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(
          [
            ['client_id', 'Client ID'],
            ['client_secret', 'Client secret'],
            ['authorization_base_url', 'Authorization URL'],
            ['token_url', 'Token URL'],
            ['redirect_url', 'Redirect URL'],
            ['scope', 'Scope'],
          ] as const
        ).map(([field, label]) => (
          <Input
            key={field}
            value={(auth[field] as string | undefined) ?? ''}
            placeholder={label}
            aria-label={label}
            disabled={disabled}
            onChange={(event) => patchAuth({ [field]: event.target.value })}
          />
        ))}
      </div>
    );
  };

  const authValue = authorizationValues(auth);
  const hasAuthorizationHeader = Object.keys(value.headers).some(
    (key) => key.toLowerCase() === 'authorization',
  );

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-indigo-500/25 bg-indigo-500/5 px-3 py-2 text-[11px] leading-relaxed text-indigo-700 dark:text-indigo-300">
        <span>
          {tr(
            '请求参数可以引用该模型的属性值，引用方法为：{{ attr_name }}',
            'Request values may reference this model’s attributes as {{ attr_name }}.',
          )}
        </span>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="w-full sm:w-32">
          <Label htmlFor="cmdb-trigger-webhook-method">{tr('方法', 'Method')}</Label>
          <Select
            id="cmdb-trigger-webhook-method"
            label={tr('方法', 'Method')}
            value={value.method}
            onValueChange={(next) => patch({ method: next })}
            options={WEBHOOK_METHODS.map((method) => ({ value: method, label: method }))}
            className="mt-1 w-full"
            disabled={disabled}
          />
        </div>
        <div className="min-w-0 flex-1">
          <Label htmlFor="cmdb-trigger-webhook-url">{tr('Webhook 地址', 'Webhook URL')}</Label>
          <Input
            id="cmdb-trigger-webhook-url"
            value={value.url}
            placeholder="https://example.test/hooks/cmdb"
            disabled={disabled}
            onChange={(event) => patch({ url: event.target.value })}
            className="mt-1 w-full font-mono"
          />
        </div>
      </div>

      <Tabs defaultValue="parameters">
        <TabsList aria-label={tr('Webhook 请求配置', 'Webhook request configuration')}>
          <TabsTrigger value="parameters">{tr('请求参数', 'Parameters')}</TabsTrigger>
          <TabsTrigger value="body">{tr('Body', 'Body')}</TabsTrigger>
          <TabsTrigger value="headers">{tr('Headers', 'Headers')}</TabsTrigger>
          <TabsTrigger value="authorization">{tr('认证', 'Authorization')}</TabsTrigger>
        </TabsList>
        <TabsContent value="parameters" className="pt-3">
          {renderRows(paramRows, (rows) => changeRows('parameters', rows), {
            key: tr('参数名', 'Parameter'),
            value: tr('参数值', 'Value'),
          })}
        </TabsContent>
        <TabsContent value="body" className="pt-3">
          <Textarea
            rows={5}
            value={value.body}
            aria-label={tr('请求 Body', 'Request body')}
            placeholder={tr('JSON 或文本请求体', 'JSON or text body')}
            disabled={disabled}
            onChange={(event) => patch({ body: event.target.value })}
            className="w-full font-mono text-xs"
          />
        </TabsContent>
        <TabsContent value="headers" className="pt-3">
          {renderRows(headerRows, (rows) => changeRows('headers', rows), {
            key: tr('Header 名称', 'Header'),
            value: tr('Header 值', 'Value'),
          })}
        </TabsContent>
        <TabsContent value="authorization" className="space-y-3 pt-3">
          <div>
            <Label htmlFor="cmdb-trigger-webhook-auth">{tr('认证类型', 'Authorization type')}</Label>
            <Select
              id="cmdb-trigger-webhook-auth"
              label={tr('认证类型', 'Authorization type')}
              value={authType}
              onValueChange={(next) => changeAuthType(next as WebhookAuthType)}
              options={WEBHOOK_AUTH_TYPES.map((item) => ({
                value: item.value,
                label: tr(item.zh, item.en),
              }))}
              className="mt-1 w-48 max-w-full"
              disabled={disabled}
            />
          </div>
          {authFields()}
          {hasStoredAuth && authType !== 'none' && Object.keys(authValue).length === 0 && (
            <p className="text-[11px] text-text-faint">
              {tr(
                '已存有一组凭据。留空保持不变；填写即替换。',
                'A credential is stored. Leave the fields empty to keep it, or fill them in to replace it.',
              )}
            </p>
          )}
          {hasAuthorizationHeader && (
            <p className="text-[11px] text-text-faint">
              {Object.keys(authValue).length === 0
                ? tr(
                    'Headers 中已设置 Authorization，将直接使用该值；在这里填写凭据会覆盖它。',
                    'An Authorization header is configured and will be used as-is; credentials here override it.',
                  )
                : tr(
                    '这里的凭据会覆盖 Headers 中的 Authorization。',
                    'These credentials override the Authorization header.',
                  )}
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
