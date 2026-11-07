import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cloud, Copy, Info, Network, Plus, RefreshCw, ScanLine, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import { describeError } from '../../api/http';
import { listAccounts, type Account, type Rule } from '../../api/discovery';
import {
  accountReference,
  boolValue,
  numberValue,
  scalarText,
  snmpNodes,
  stringList,
  withSnmpNodes,
  type ProviderSecrets,
  type SnmpNode,
} from './providerConfig';
import { ruleCategory, ruleProviderKey, ruleResources } from './rulePresentation';

// The provider-specific half of a target.
//
// THE FORM EDITS EXTRA_OPTION, BUT NEVER ITS CREDENTIALS. `key`, `secret`,
// `password` and `community` arrive blank with a `has_*` flag; leaving one
// blank keeps the stored ciphertext, and typing one replaces it. A referenced
// account is the other mode: it supplies the credentials, so the inline fields
// are disabled and only `_reference` is written.

export type StoredCredentials = {
  hasKey: boolean;
  hasSecret: boolean;
  hasPassword: boolean;
  hasCommunity: boolean;
};

export function ProviderConfig({
  rule,
  extra,
  secrets,
  stored,
  refreshKey,
  canEditRule,
  onExtraChange,
  onSecretsChange,
  onManageAccounts,
}: {
  rule: Rule;
  extra: Record<string, unknown>;
  secrets: ProviderSecrets;
  stored: StoredCredentials;
  refreshKey: number;
  canEditRule: boolean;
  onExtraChange(patch: Record<string, unknown>): void;
  onSecretsChange(patch: Partial<ProviderSecrets>): void;
  onManageAccounts(): void;
}) {
  const { tr } = useI18n();
  const privateCloud = ruleCategory(rule) === 'private_cloud' || ruleProviderKey(rule) === 'vcenter';
  const isHTTP = rule.type === 'http';
  const isSNMP = rule.type === 'snmp';
  const isComponents = rule.type === 'components';
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsErr, setAccountsErr] = useState<string | null>(null);
  const [accountsNonce, setAccountsNonce] = useState(0);

  const loadAccounts = useCallback(async () => {
    if (!isHTTP) return;
    setAccountsLoading(true);
    setAccountsErr(null);
    try {
      setAccounts(await listAccounts(rule.id));
    } catch (error) {
      setAccountsErr(describeError(error, tr('无法读取规则账号', 'Could not load the rule accounts')));
    } finally {
      setAccountsLoading(false);
    }
  }, [isHTTP, rule.id, tr]);

  useEffect(() => {
    void loadAccounts();
  }, [accountsNonce, loadAccounts, refreshKey]);

  const reference = accountReference(extra);
  const usingReference = reference !== '';
  const categories = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of ruleResources(rule)) {
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
    const current = scalarText(extra.category);
    if (current && !seen.has(current)) out.push(current);
    return out;
  }, [extra.category, rule]);
  const accountOptions = useMemo(() => {
    const options = accounts.map((account) => ({
      value: String(account.id),
      label: account.name || `#${account.id}`,
    }));
    if (reference && !options.some((option) => option.value === reference)) {
      options.push({ value: reference, label: `#${reference}` });
    }
    return [{ value: '', label: tr('不使用账号引用', 'No account reference') }, ...options];
  }, [accounts, reference, tr]);

  if (!isHTTP && !isSNMP && !isComponents) return null;

  return (
    <div className="flex flex-col gap-4">
      {isHTTP && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-300">
          <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {tr(
              '当前阶段保存采集参数；云平台采集器尚未实现，目标不会下发执行。',
              'Collection settings are saved here; cloud adapters are not implemented yet, so the target is not dispatched.',
            )}
          </span>
        </div>
      )}

      {isHTTP && (
        <>
          {categories.length > 0 ? (
            <div>
              <Label htmlFor={`cmdb-provider-category-${rule.id}`}>{tr('资源类型', 'Resource kind')}</Label>
              <Select
                id={`cmdb-provider-category-${rule.id}`}
                label={tr('资源类型', 'Resource kind')}
                value={scalarText(extra.category)}
                onValueChange={(value) => onExtraChange({ category: value })}
                options={[
                  { value: '', label: tr('（未选择）', '(none)') },
                  ...categories.map((item) => ({ value: item, label: item })),
                ]}
                searchable={categories.length > 10}
                className="mt-1 w-full"
              />
              <p className="mt-1 text-[11px] text-text-faint">
                {tr('决定采集哪个云资源；保存时会同步 provider 和 collect_key。', 'Chooses the cloud resource; provider and collect_key are derived on save.')}
              </p>
            </div>
          ) : (
            <div>
              <Label htmlFor={`cmdb-provider-category-${rule.id}`}>{tr('资源类型', 'Resource kind')}</Label>
              <Input
                id={`cmdb-provider-category-${rule.id}`}
                value={scalarText(extra.category)}
                onChange={(event) => onExtraChange({ category: event.target.value })}
                placeholder="ecs"
                className="mt-1 w-full font-mono"
              />
            </div>
          )}

          <div>
            <Label htmlFor={`cmdb-provider-reference-${rule.id}`}>{tr('账号引用', 'Account reference')}</Label>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Select
                id={`cmdb-provider-reference-${rule.id}`}
                label={tr('账号引用', 'Account reference')}
                value={reference}
                onValueChange={(value) => onExtraChange({ _reference: value })}
                options={accountOptions}
                searchable={accountOptions.length > 10}
                disabled={accountsLoading}
                className="min-w-48 flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => setAccountsNonce((current) => current + 1)}
                disabled={accountsLoading}
                aria-label={tr('刷新账号列表', 'Refresh accounts')}
                title={tr('刷新账号列表', 'Refresh accounts')}
              >
                <RefreshCw size={12} className={cn(accountsLoading && 'animate-spin')} aria-hidden="true" />
              </Button>
              {canEditRule && (
                <Button variant="outline" size="sm" type="button" onClick={onManageAccounts}>
                  {tr('管理账号', 'Manage accounts')}
                </Button>
              )}
            </div>
            {accountsErr && (
              <p role="alert" className="mt-1 text-[11px] text-amber-600 dark:text-amber-300">
                {accountsErr}
              </p>
            )}
            <p className="mt-1 text-[11px] text-text-faint">
              {usingReference
                ? tr('凭据由选中的规则账号提供；内联凭据字段已禁用。', 'Credentials come from the selected rule account; inline credential fields are disabled.')
                : tr('也可以引用规则账号，避免在每个目标里重复填写凭据。', 'You can reference a rule account instead of repeating credentials on every target.')}
            </p>
          </div>

          {privateCloud ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor={`cmdb-provider-host-${rule.id}`}>{tr('地址', 'Host')}</Label>
                <Input
                  id={`cmdb-provider-host-${rule.id}`}
                  value={scalarText(extra.host)}
                  onChange={(event) => onExtraChange({ host: event.target.value })}
                  disabled={usingReference}
                  placeholder="vcenter.example.com"
                  className="mt-1 w-full font-mono"
                />
              </div>
              <div>
                <Label htmlFor={`cmdb-provider-account-${rule.id}`}>{tr('用户名', 'Account')}</Label>
                <Input
                  id={`cmdb-provider-account-${rule.id}`}
                  value={scalarText(extra.account)}
                  onChange={(event) => onExtraChange({ account: event.target.value })}
                  disabled={usingReference}
                  className="mt-1 w-full"
                />
              </div>
              <div>
                <Label htmlFor={`cmdb-provider-password-${rule.id}`}>{tr('密码', 'Password')}</Label>
                <Input
                  id={`cmdb-provider-password-${rule.id}`}
                  type="password"
                  autoComplete="new-password"
                  value={secrets.password}
                  onChange={(event) => onSecretsChange({ password: event.target.value })}
                  disabled={usingReference}
                  placeholder={stored.hasPassword ? tr('已设置，留空保持原值', 'Stored; leave blank to keep') : ''}
                  className="mt-1 w-full"
                />
              </div>
              <div>
                <Label htmlFor={`cmdb-provider-vcenter-name-${rule.id}`}>{tr('vCenter 名称', 'vCenter name')}</Label>
                <Input
                  id={`cmdb-provider-vcenter-name-${rule.id}`}
                  value={scalarText(extra.vcenterName)}
                  onChange={(event) => onExtraChange({ vcenterName: event.target.value })}
                  className="mt-1 w-full"
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor={`cmdb-provider-key-${rule.id}`}>{tr('Access key', 'Access key')}</Label>
                <Input
                  id={`cmdb-provider-key-${rule.id}`}
                  value={secrets.key}
                  onChange={(event) => onSecretsChange({ key: event.target.value })}
                  disabled={usingReference}
                  placeholder={stored.hasKey ? tr('已设置，留空保持原值', 'Stored; leave blank to keep') : ''}
                  className="mt-1 w-full font-mono"
                />
              </div>
              <div>
                <Label htmlFor={`cmdb-provider-secret-${rule.id}`}>{tr('Secret', 'Secret')}</Label>
                <Input
                  id={`cmdb-provider-secret-${rule.id}`}
                  type="password"
                  autoComplete="new-password"
                  value={secrets.secret}
                  onChange={(event) => onSecretsChange({ secret: event.target.value })}
                  disabled={usingReference}
                  placeholder={stored.hasSecret ? tr('已设置，留空保持原值', 'Stored; leave blank to keep') : ''}
                  className="mt-1 w-full"
                />
              </div>
            </div>
          )}
        </>
      )}

      {isSNMP && (
        <SnmpFields
          rule={rule}
          extra={extra}
          secrets={secrets}
          stored={stored}
          onExtraChange={onExtraChange}
          onSecretsChange={onSecretsChange}
        />
      )}

      {isComponents && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor={`cmdb-provider-cidr-${rule.id}`}>{tr('CIDR', 'CIDR')}</Label>
            <Input
              id={`cmdb-provider-cidr-${rule.id}`}
              value={scalarText(extra.cidr)}
              onChange={(event) => onExtraChange({ cidr: event.target.value })}
              placeholder="192.168.0.0/16"
              className="mt-1 w-full font-mono"
            />
          </div>
          <div>
            <Label htmlFor={`cmdb-provider-ports-${rule.id}`}>{tr('端口范围', 'Ports')}</Label>
            <Input
              id={`cmdb-provider-ports-${rule.id}`}
              value={scalarText(extra.ports)}
              onChange={(event) => onExtraChange({ ports: event.target.value })}
              placeholder="8000-8800"
              className="mt-1 w-full font-mono"
            />
          </div>
          <div>
            <Label htmlFor={`cmdb-provider-enable-cidr-${rule.id}`}>{tr('启用 CIDR', 'Enable CIDR')}</Label>
            <Input
              id={`cmdb-provider-enable-cidr-${rule.id}`}
              value={scalarText(extra.enable_cidr)}
              onChange={(event) => onExtraChange({ enable_cidr: event.target.value })}
              placeholder="0x1234"
              className="mt-1 w-full font-mono"
            />
          </div>
          <p className="text-[11px] text-text-faint sm:col-span-3">
            {tr(
              '端口扫描参数会随组件任务下发，是否使用取决于采集插件。',
              'Port-scan settings are delivered with the component task; whether they are used depends on the collector plugin.',
            )}
          </p>
        </div>
      )}
    </div>
  );
}

function SnmpFields({
  rule,
  extra,
  secrets,
  stored,
  onExtraChange,
  onSecretsChange,
}: {
  rule: Rule;
  extra: Record<string, unknown>;
  secrets: ProviderSecrets;
  stored: StoredCredentials;
  onExtraChange(patch: Record<string, unknown>): void;
  onSecretsChange(patch: Partial<ProviderSecrets>): void;
}) {
  const { tr } = useI18n();
  const [cidrDraft, setCidrDraft] = useState('');
  const nodes = snmpNodes(extra);
  const cidrs = stringList(extra.cidr);

  const setNodes = (next: SnmpNode[]) => onExtraChange(withSnmpNodes(extra, next));
  const patchNode = (index: number, patch: Partial<SnmpNode>) => {
    setNodes(nodes.map((node, current) => (current === index ? { ...node, ...patch } : node)));
  };
  const copyNode = (index: number) => {
    setNodes([...nodes, { ...nodes[index] }]);
  };
  const removeNode = (index: number) => {
    if (nodes.length <= 1) {
      setNodes([{ ip: '', version: '2c' }]);
      return;
    }
    setNodes(nodes.filter((_, current) => current !== index));
  };
  const addCidr = () => {
    const value = cidrDraft.trim();
    if (!value) return;
    onExtraChange({ cidr: [...cidrs, value] });
    setCidrDraft('');
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium text-text">{tr('SNMP 节点', 'SNMP nodes')}</p>
            <p className="mt-0.5 text-[11px] text-text-faint">
              {tr('为每个节点单独设置版本和 community。', 'Set a version and community per node.')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => setNodes([...nodes, { ip: '', version: '2c' }])}
            className="inline-flex items-center gap-1"
          >
            <Plus size={12} aria-hidden="true" />
            {tr('添加节点', 'Add node')}
          </Button>
        </div>
        <div className="mt-2 flex flex-col gap-2">
          {nodes.map((node, index) => (
            <div
              key={index}
              className="grid grid-cols-1 gap-2 rounded-md border border-border bg-card/40 p-2.5 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_auto] sm:items-center"
            >
              <Input
                aria-label={tr(`节点 ${index + 1} IP`, `Node ${index + 1} IP`)}
                value={node.ip}
                onChange={(event) => patchNode(index, { ip: event.target.value })}
                placeholder="10.0.0.1"
                className="w-full font-mono"
              />
              <Select
                aria-label={tr(`节点 ${index + 1} 版本`, `Node ${index + 1} version`)}
                label={tr(`节点 ${index + 1} 版本`, `Node ${index + 1} version`)}
                value={node.version || '2c'}
                onValueChange={(value) => patchNode(index, { version: value })}
                options={[
                  { value: '1', label: 'v1' },
                  { value: '2c', label: 'v2c' },
                ]}
                className="w-full"
              />
              <Input
                aria-label={tr(`节点 ${index + 1} community`, `Node ${index + 1} community`)}
                type="password"
                autoComplete="new-password"
                value={node.community ?? ''}
                onChange={(event) => patchNode(index, { community: event.target.value })}
                placeholder={node.has_community ? tr('已设置，留空保持原值', 'Stored; leave blank to keep') : 'community'}
                className="w-full"
              />
              <div className="flex items-center gap-1">
                <Button
                  variant="subtle"
                  size="sm"
                  type="button"
                  onClick={() => copyNode(index)}
                  aria-label={tr(`复制节点 ${index + 1}`, `Copy node ${index + 1}`)}
                  title={tr('复制', 'Copy')}
                  className="size-7 rounded-full px-0"
                >
                  <Copy size={12} aria-hidden="true" />
                </Button>
                <Button
                  variant="subtle"
                  size="sm"
                  type="button"
                  onClick={() => removeNode(index)}
                  aria-label={tr(`删除节点 ${index + 1}`, `Delete node ${index + 1}`)}
                  title={tr('删除', 'Delete')}
                  className="size-7 rounded-full px-0"
                >
                  <Trash2 size={12} aria-hidden="true" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor={`cmdb-snmp-version-${rule.id}`}>{tr('默认版本', 'Default version')}</Label>
          <Select
            id={`cmdb-snmp-version-${rule.id}`}
            label={tr('默认版本', 'Default version')}
            value={scalarText(extra.version) || '2c'}
            onValueChange={(value) => onExtraChange({ version: value })}
            options={[
              { value: '1', label: 'v1' },
              { value: '2c', label: 'v2c' },
            ]}
            className="mt-1 w-full"
          />
        </div>
        <div>
          <Label htmlFor={`cmdb-snmp-community-${rule.id}`}>{tr('默认 community', 'Default community')}</Label>
          <Input
            id={`cmdb-snmp-community-${rule.id}`}
            type="password"
            autoComplete="new-password"
            value={secrets.community}
            onChange={(event) => onSecretsChange({ community: event.target.value })}
            placeholder={stored.hasCommunity ? tr('已设置，留空保持原值', 'Stored; leave blank to keep') : ''}
            className="mt-1 w-full"
          />
        </div>
        <div>
          <Label htmlFor={`cmdb-snmp-timeout-${rule.id}`}>{tr('超时（秒）', 'Timeout (s)')}</Label>
          <Input
            id={`cmdb-snmp-timeout-${rule.id}`}
            type="number"
            min={1}
            value={numberValue(extra.timeout, 5)}
            onChange={(event) => onExtraChange({ timeout: Number(event.target.value) })}
            className="mt-1 w-full"
          />
        </div>
        <div>
          <Label htmlFor={`cmdb-snmp-retries-${rule.id}`}>{tr('重试次数', 'Retries')}</Label>
          <Input
            id={`cmdb-snmp-retries-${rule.id}`}
            type="number"
            min={0}
            value={numberValue(extra.retries, 3)}
            onChange={(event) => onExtraChange({ retries: Number(event.target.value) })}
            className="mt-1 w-full"
          />
        </div>
        <div>
          <Label htmlFor={`cmdb-snmp-initial-${rule.id}`}>{tr('初始节点', 'Initial node')}</Label>
          <Input
            id={`cmdb-snmp-initial-${rule.id}`}
            value={scalarText(extra.initial_node)}
            onChange={(event) => onExtraChange({ initial_node: event.target.value })}
            className="mt-1 w-full font-mono"
          />
        </div>
        <div>
          <Label htmlFor={`cmdb-snmp-depth-${rule.id}`}>{tr('最大深度', 'Max depth')}</Label>
          <Input
            id={`cmdb-snmp-depth-${rule.id}`}
            type="number"
            min={1}
            value={numberValue(extra.max_depth, 5)}
            onChange={(event) => onExtraChange({ max_depth: Number(event.target.value) })}
            className="mt-1 w-full"
          />
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2 text-xs text-text-muted">
        <span>{tr('递归扫描', 'Recursive scan')}</span>
        <Switch
          aria-label={tr('递归扫描', 'Recursive scan')}
          checked={boolValue(extra.recursive_scan, true)}
          onCheckedChange={(value) => onExtraChange({ recursive_scan: value })}
        />
      </label>
      <p className="text-[11px] leading-5 text-text-muted">
        {tr(
          '当前采集器按上方节点列表采集；CIDR、初始节点、最大深度和递归扫描字段会保存，但尚未执行。',
          'The collector walks the node list above; CIDR, initial node, max depth and recursive scan are saved but not executed yet.',
        )}
      </p>

      <div>
        <Label>{tr('扫描 CIDR', 'Scan CIDR')}</Label>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-card/40 p-2">
          {cidrs.map((cidr) => (
            <span key={cidr} className="inline-flex items-center gap-1 rounded bg-indigo-500/10 px-2 py-0.5 text-[11px] text-indigo-600 dark:text-indigo-300">
              {cidr}
              <button
                type="button"
                onClick={() => onExtraChange({ cidr: cidrs.filter((item) => item !== cidr) })}
                aria-label={tr(`删除 CIDR ${cidr}`, `Remove CIDR ${cidr}`)}
                className="opacity-70 hover:opacity-100"
              >
                <X size={11} aria-hidden="true" />
              </button>
            </span>
          ))}
          <Input
            aria-label={tr('添加扫描 CIDR', 'Add scan CIDR')}
            value={cidrDraft}
            onChange={(event) => setCidrDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addCidr();
              }
            }}
            placeholder={tr('192.168.0.0/16', '192.168.0.0/16')}
            className="h-7 w-40 font-mono"
          />
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={addCidr}
            disabled={!cidrDraft.trim()}
            className="inline-flex items-center gap-1"
          >
            <Plus size={11} aria-hidden="true" />
            {tr('添加', 'Add')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// The card title uses the rule's kind, so the same fields do not claim to be
// about the wrong provider.
export function providerTitle(rule: Rule, tr: (zh: string, en: string) => string): { icon: typeof Cloud; title: string; hint: string } {
  if (rule.type === 'snmp') {
    return {
      icon: Network,
      title: tr('SNMP 参数', 'SNMP settings'),
      hint: tr('节点、community、超时和扫描 CIDR。', 'Nodes, community, timeouts and scan CIDRs.'),
    };
  }
  if (rule.type === 'components') {
    return {
      icon: ScanLine,
      title: tr('端口扫描参数', 'Port-scan settings'),
      hint: tr('组件采集使用的 CIDR、端口范围和启用参数。', 'CIDR, port range and enable settings used by component collection.'),
    };
  }
  if (ruleCategory(rule) === 'private_cloud' || ruleProviderKey(rule) === 'vcenter') {
    return {
      icon: Cloud,
      title: tr('私有云参数', 'Private-cloud settings'),
      hint: tr('账号引用、vCenter 地址和凭据。', 'Account reference, vCenter host and credentials.'),
    };
  }
  return {
    icon: Cloud,
    title: tr('云平台参数', 'Cloud settings'),
    hint: tr('资源类型、账号引用和访问密钥。', 'Resource kind, account reference and access key.'),
  };
}
