import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { useI18n } from '@/i18n/locale';

import { describeError } from '../../api/http';
import {
  listAccounts,
  replaceAccounts,
  type Account,
  type AccountInput,
  type Rule,
} from '../../api/discovery';
import { useToast } from '../Toast';
import { ruleProviderKey } from './rulePresentation';

// 云账号 — the focused account form for the shipped HTTP providers.
//
// CANTOR SPLIT THE TWO SHAPES: the four public clouds take a `key`/`secret`
// pair, vCenter takes `host`/`account`/`password`. The rule drawer keeps the
// generic JSON editor for everything else; this is the common path, so an
// operator does not have to hand-write a config object to add a key.
//
// SECRETS ARE NEVER READ BACK. The API returns `has_secret`/`has_password`
// instead, so the password inputs start blank and a blank one means "keep the
// stored value" — the backend merges the stored entry when the key is absent
// from the write.

type AccountDraft = {
  /** Stable React key; the account id when it already exists. */
  rowKey: string;
  id?: number;
  name: string;
  /** The stored config, minus the credential entries the read path strips. */
  config: Record<string, unknown>;
  accessKey: string;
  secret: string;
  host: string;
  account: string;
  password: string;
  hasSecret: boolean;
  hasPassword: boolean;
  hasKey: boolean;
};

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function draftFrom(account: Account, index: number): AccountDraft {
  const config = account.config ?? {};
  return {
    rowKey: account.id != null ? `id-${account.id}` : `new-${index}`,
    id: account.id,
    name: account.name,
    config: { ...config },
    // `key` is credential material too, so the read path strips it and reports
    // has_key instead. A blank field means "keep the stored value".
    accessKey: '',
    secret: '',
    host: textOf(config.host),
    account: textOf(config.account),
    password: '',
    hasSecret: account.has_secret,
    hasPassword: account.has_password,
    hasKey: account.has_key ?? false,
  };
}

function emptyDraft(index: number): AccountDraft {
  return {
    rowKey: `new-${Date.now()}-${index}`,
    name: '',
    config: {},
    accessKey: '',
    secret: '',
    host: '',
    account: '',
    password: '',
    hasSecret: false,
    hasPassword: false,
    hasKey: false,
  };
}

export function AccountConfigDialog({ rule, onClose }: { rule: Rule; onClose(): void }) {
  const { tr } = useI18n();
  const toast = useToast();

  const provider = ruleProviderKey(rule);
  const vcenter = provider === 'vcenter';

  const [drafts, setDrafts] = useState<AccountDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nextKey = useRef(1);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr(null);
    void listAccounts(rule.id)
      .then((rows) => {
        if (live) setDrafts(rows.map(draftFrom));
      })
      .catch((error) => {
        if (live) setErr(describeError(error, tr('无法读取账号', 'Could not load the accounts')));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [rule.id, tr]);

  const update = (rowKey: string, patch: Partial<AccountDraft>) => {
    setDrafts((current) =>
      current.map((draft) => (draft.rowKey === rowKey ? { ...draft, ...patch } : draft)),
    );
  };

  const add = () => {
    setDrafts((current) => [...current, emptyDraft(nextKey.current++)]);
  };

  const remove = (rowKey: string) => {
    setDrafts((current) => current.filter((draft) => draft.rowKey !== rowKey));
  };

  const submit = async () => {
    const inputs: AccountInput[] = [];
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index];
      const name = draft.name.trim();
      if (!name) {
        setErr(tr(`第 ${index + 1} 个账号没有名称`, `Account ${index + 1} has no name`));
        return;
      }
      if (vcenter) {
        if (!draft.host.trim()) {
          setErr(tr(`第 ${index + 1} 个账号没有填写地址`, `Account ${index + 1} has no host`));
          return;
        }
        if (!draft.account.trim()) {
          setErr(tr(`第 ${index + 1} 个账号没有填写用户名`, `Account ${index + 1} has no account`));
          return;
        }
      } else if (!draft.hasKey && !draft.accessKey.trim()) {
        setErr(tr(`第 ${index + 1} 个账号没有填写 key`, `Account ${index + 1} has no key`));
        return;
      }

      // ABSENT MEANS KEEP. `sealAccountConfig` merges the stored entry when the
      // credential key is not in the write, so a blank input must not be sent
      // as an empty string — that would clear the stored secret.
      const config = { ...draft.config };
      if (vcenter) {
        config.host = draft.host.trim();
        config.account = draft.account.trim();
        if (draft.password.trim()) config.password = draft.password;
        else delete config.password;
      } else {
        if (draft.accessKey.trim()) config.key = draft.accessKey.trim();
        else delete config.key;
        if (draft.secret.trim()) config.secret = draft.secret;
        else delete config.secret;
      }
      inputs.push({
        ...(draft.id != null ? { id: draft.id } : {}),
        name,
        config,
      });
    }

    setSaving(true);
    setErr(null);
    try {
      await replaceAccounts(rule.id, inputs);
      toast.success(tr('已保存', 'Saved'));
      onClose();
    } catch (error) {
      setErr(describeError(error, tr('保存失败', 'Could not save')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[min(85vh,44rem)] w-[min(46rem,calc(100vw-2rem))] max-w-none flex-col p-0">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <DialogTitle className="text-base font-semibold text-text">
              {vcenter
                ? tr(`${rule.name} · 私有云账号`, `${rule.name} · Private cloud account`)
                : tr(`${rule.name} · 云访问密钥`, `${rule.name} · Cloud access key`)}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-5 text-text-muted">
              {tr(
                '账号属于创建者；密钥和密码保存后不再回显，留空表示保持原值。',
                'An account belongs to its creator. Secrets are never shown again; leave the field blank to keep the stored value.',
              )}
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tr('关闭', 'Close')}
            className="shrink-0 rounded p-1 text-text-faint hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {err && (
            <p
              role="alert"
              className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300"
            >
              {err}
            </p>
          )}

          {loading ? (
            <p className="py-8 text-center text-xs text-text-muted">{tr('加载账号…', 'Loading accounts…')}</p>
          ) : drafts.length === 0 ? (
            <p className="py-6 text-center text-xs text-text-faint">
              {tr('这条规则还没有账号。', 'This rule has no accounts yet.')}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {drafts.map((draft, index) => (
                <div key={draft.rowKey} className="rounded-lg border border-border/60 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-text-faint">
                      {tr(`账号 ${index + 1}`, `Account ${index + 1}`)}
                    </span>
                    <Button
                      variant="dangerGhost"
                      size="sm"
                      type="button"
                      onClick={() => remove(draft.rowKey)}
                      aria-label={tr(`删除账号 ${index + 1}`, `Remove account ${index + 1}`)}
                      className="inline-flex size-7 items-center justify-center p-0"
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="min-w-0">
                      <Label htmlFor={`cmdb-cloud-account-name-${draft.rowKey}`}>
                        {tr('名称', 'Name')}
                      </Label>
                      <Input
                        id={`cmdb-cloud-account-name-${draft.rowKey}`}
                        aria-label={tr(`账号名称 ${index + 1}`, `Account name ${index + 1}`)}
                        value={draft.name}
                        onChange={(event) => update(draft.rowKey, { name: event.target.value })}
                        className="mt-1 w-full"
                      />
                    </div>

                    {vcenter ? (
                      <>
                        <div className="min-w-0">
                          <Label htmlFor={`cmdb-cloud-account-host-${draft.rowKey}`}>
                            {tr('地址', 'Host')}
                          </Label>
                          <Input
                            id={`cmdb-cloud-account-host-${draft.rowKey}`}
                            aria-label={tr(`账号地址 ${index + 1}`, `Account host ${index + 1}`)}
                            value={draft.host}
                            onChange={(event) => update(draft.rowKey, { host: event.target.value })}
                            placeholder="vcenter.example.com"
                            className="mt-1 w-full font-mono"
                          />
                        </div>
                        <div className="min-w-0">
                          <Label htmlFor={`cmdb-cloud-account-user-${draft.rowKey}`}>
                            {tr('用户名', 'Account')}
                          </Label>
                          <Input
                            id={`cmdb-cloud-account-user-${draft.rowKey}`}
                            aria-label={tr(`账号用户名 ${index + 1}`, `Account user ${index + 1}`)}
                            value={draft.account}
                            onChange={(event) => update(draft.rowKey, { account: event.target.value })}
                            className="mt-1 w-full"
                          />
                        </div>
                        <div className="min-w-0">
                          <Label htmlFor={`cmdb-cloud-account-password-${draft.rowKey}`}>
                            {tr('密码', 'Password')}
                          </Label>
                          <Input
                            id={`cmdb-cloud-account-password-${draft.rowKey}`}
                            type="password"
                            autoComplete="new-password"
                            aria-label={tr(`账号密码 ${index + 1}`, `Account password ${index + 1}`)}
                            value={draft.password}
                            onChange={(event) => update(draft.rowKey, { password: event.target.value })}
                            placeholder={
                              draft.hasPassword
                                ? tr('已设置，留空保持原值', 'Stored; leave blank to keep')
                                : ''
                            }
                            className="mt-1 w-full"
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="min-w-0">
                          <Label htmlFor={`cmdb-cloud-account-key-${draft.rowKey}`}>
                            {tr('Access key', 'Access key')}
                          </Label>
                          <Input
                            id={`cmdb-cloud-account-key-${draft.rowKey}`}
                            aria-label={tr(`账号 key ${index + 1}`, `Account key ${index + 1}`)}
                            value={draft.accessKey}
                            onChange={(event) => update(draft.rowKey, { accessKey: event.target.value })}
                            placeholder={
                              draft.hasKey
                                ? tr('已设置，留空保持原值', 'Stored; leave blank to keep')
                                : ''
                            }
                            className="mt-1 w-full font-mono"
                          />
                        </div>
                        <div className="min-w-0">
                          <Label htmlFor={`cmdb-cloud-account-secret-${draft.rowKey}`}>
                            {tr('Secret', 'Secret')}
                          </Label>
                          <Input
                            id={`cmdb-cloud-account-secret-${draft.rowKey}`}
                            type="password"
                            autoComplete="new-password"
                            aria-label={tr(`账号 secret ${index + 1}`, `Account secret ${index + 1}`)}
                            value={draft.secret}
                            onChange={(event) => update(draft.rowKey, { secret: event.target.value })}
                            placeholder={
                              draft.hasSecret
                                ? tr('已设置，留空保持原值', 'Stored; leave blank to keep')
                                : ''
                            }
                            className="mt-1 w-full"
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={add}
            disabled={loading || saving}
            className="mt-3 inline-flex items-center gap-1.5"
          >
            <Plus size={12} aria-hidden="true" />
            {tr('添加账号', 'Add account')}
          </Button>
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" type="button" onClick={onClose} disabled={saving}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={() => void submit()}
            disabled={loading || saving}
          >
            {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
