import { useState } from 'react';
import { Plus, X } from 'lucide-react';

import type { User } from '@/api/users';
import type { TypeAttribute } from '../../api/citype';
import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useI18n } from '@/i18n/locale';

import { NOTIFY_METHODS } from './types';
import { UserMultiSelect } from './UserMultiSelect';

/**
 * The notification half of a trigger action.
 *
 * The recipients are IAM users plus custom email addresses. The trigger option
 * stores `notifies.tos` as strings because that is the shape this service
 * validates; a later sender can consume the same values. Delivery itself is
 * not wired in this build, and the caller states that in the form.
 */
export function TriggerNotifyEditor({
  users,
  usersLoading,
  usersError,
  recipientEmails,
  onRecipientEmailsChange,
  customEmail,
  onCustomEmailChange,
  subject,
  onSubjectChange,
  body,
  onBodyChange,
  methods,
  onMethodsChange,
  attributes,
  disabled = false,
}: {
  users: User[];
  usersLoading: boolean;
  usersError?: string | null;
  recipientEmails: string[];
  onRecipientEmailsChange(next: string[]): void;
  customEmail: string;
  onCustomEmailChange(value: string): void;
  subject: string;
  onSubjectChange(value: string): void;
  body: string;
  onBodyChange(value: string): void;
  methods: string[];
  onMethodsChange(next: string[]): void;
  attributes: TypeAttribute[];
  disabled?: boolean;
}) {
  const { tr } = useI18n();
  const [showCustomEmail, setShowCustomEmail] = useState(customEmail.trim() !== '');
  const otherMethods = methods.filter(
    (method) => !NOTIFY_METHODS.some((item) => item.value === method),
  );

  const removeRecipient = (email: string) =>
    onRecipientEmailsChange(recipientEmails.filter((item) => item !== email));

  const toggleMethod = (method: string) => {
    const next = new Set(methods);
    if (next.has(method)) next.delete(method);
    else next.add(method);
    onMethodsChange([...next]);
  };

  const insertAttribute = (name: string) => {
    if (!name) return;
    onBodyChange(`${body}${body && !body.endsWith('\n') ? '\n' : ''}{{ ${name} }}`);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-indigo-500/25 bg-indigo-500/5 px-3 py-2 text-[11px] leading-relaxed text-indigo-700 dark:text-indigo-300">
        <span>
          {tr(
            '标题、内容可以引用该模型的属性值，引用方法为：{{ attr_name }}',
            'The subject and content may reference this model’s attributes as {{ attr_name }}.',
          )}
        </span>
      </div>

      <div>
        <Label>{tr('收件人', 'Recipients')}</Label>
        <div className="mt-1">
          <UserMultiSelect
            users={users}
            selected={recipientEmails}
            loading={usersLoading}
            disabled={disabled}
            onChange={onRecipientEmailsChange}
          />
        </div>
        {usersError && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-300">{usersError}</p>}
        {recipientEmails.length > 0 && (
          <div className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
            {recipientEmails.map((email) => (
              <Chip key={email} dense className="max-w-full gap-1">
                <span className="truncate">{email}</span>
                <button
                  type="button"
                  onClick={() => removeRecipient(email)}
                  disabled={disabled}
                  aria-label={tr(`移除收件人 ${email}`, `Remove recipient ${email}`)}
                  className="shrink-0 rounded text-text-faint hover:text-text disabled:cursor-not-allowed"
                >
                  <X size={10} aria-hidden="true" />
                </button>
              </Chip>
            ))}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => setShowCustomEmail((current) => !current)}
            disabled={disabled}
            className="inline-flex items-center gap-1"
          >
            <Plus size={12} aria-hidden="true" />
            {showCustomEmail ? tr('收起自定义收件人', 'Hide custom recipients') : tr('添加自定义收件人', 'Add custom recipients')}
          </Button>
        </div>
        {showCustomEmail && (
          <div className="mt-2">
            <Label htmlFor="cmdb-trigger-custom-email">{tr('自定义收件人', 'Custom recipients')}</Label>
            <Textarea
              id="cmdb-trigger-custom-email"
              rows={2}
              value={customEmail}
              placeholder={tr('多个邮箱用分号或逗号分隔', 'Separate multiple emails with ; or ,')}
              disabled={disabled}
              onChange={(event) => onCustomEmailChange(event.target.value)}
              className="mt-1 w-full font-mono text-xs"
            />
          </div>
        )}
      </div>

      <div>
        <Label htmlFor="cmdb-trigger-subject">{tr('通知标题', 'Subject')}</Label>
        <Input
          id="cmdb-trigger-subject"
          value={subject}
          placeholder={tr('请输入通知标题', 'Notification subject')}
          disabled={disabled}
          onChange={(event) => onSubjectChange(event.target.value)}
          className="mt-1 w-full"
        />
      </div>

      <div>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <Label htmlFor="cmdb-trigger-body">{tr('通知内容', 'Content')}</Label>
          {attributes.length > 0 && (
            <div className="w-44 max-w-full">
              <Select
                value=""
                label={tr('插入属性引用', 'Insert attribute reference')}
                placeholder={tr('插入属性引用…', 'Insert attribute…')}
                options={attributes.map((attribute) => ({
                  value: attribute.name,
                  label: attribute.alias || attribute.name,
                }))}
                onValueChange={insertAttribute}
                disabled={disabled}
                className="w-full"
              />
            </div>
          )}
        </div>
        <Textarea
          id="cmdb-trigger-body"
          rows={6}
          value={body}
          placeholder={tr('请输入通知内容，可用 {{ attr_name }} 引用属性。', 'Notification content; use {{ attr_name }} to reference an attribute.')}
          disabled={disabled}
          onChange={(event) => onBodyChange(event.target.value)}
          className="mt-1 w-full"
        />
      </div>

      <div>
        <Label>{tr('通知方式', 'Channels')}</Label>
        <div className="mt-1.5 flex flex-wrap items-center gap-4">
          {NOTIFY_METHODS.map((method) => (
            <label key={method.value} className="flex items-center gap-2 text-xs text-text-muted">
              <Checkbox
                checked={methods.includes(method.value)}
                disabled={disabled}
                onCheckedChange={() => toggleMethod(method.value)}
                aria-label={tr(method.zh, method.en)}
              />
              {tr(method.zh, method.en)}
            </label>
          ))}
        </div>
        {otherMethods.length > 0 && (
          <p className="mt-1 text-[11px] text-text-faint">
            {tr(
              `其他已配置渠道将被保留：${otherMethods.join('、')}`,
              `Other configured channels are preserved: ${otherMethods.join(', ')}`,
            )}
          </p>
        )}
      </div>
    </div>
  );
}
