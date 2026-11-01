import { useMemo, useState } from 'react';
import { ChevronDown, Search, UserRound } from 'lucide-react';

import type { User } from '@/api/users';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/Popover';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

/**
 * Recipient picker for a notification trigger.
 *
 * The CMDB service does not own an employee tree, so the console uses the IAM
 * user list it already can read. Emails are the wire value because the trigger
 * option's `notifies.tos` is a list of strings; an id would be meaningless to
 * the later sender.
 */
export function UserMultiSelect({
  users,
  selected,
  loading = false,
  disabled = false,
  onChange,
}: {
  users: User[];
  /** Selected emails, including custom recipients that are not IAM users. */
  selected: string[];
  loading?: boolean;
  disabled?: boolean;
  onChange(next: string[]): void;
}) {
  const { tr } = useI18n();
  const [query, setQuery] = useState('');
  const chosen = useMemo(() => new Set(selected), [selected]);
  const ordered = useMemo(
    () =>
      [...users].sort((left, right) =>
        (left.display_name || left.email).localeCompare(right.display_name || right.email),
      ),
    [users],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return ordered;
    return ordered.filter((user) =>
      `${user.display_name} ${user.email}`.toLowerCase().includes(needle),
    );
  }, [ordered, query]);
  const selectedUsers = ordered.filter((user) => chosen.has(user.email));
  const customCount = selected.length - selectedUsers.length;
  const label =
    selected.length === 0
      ? tr('选择员工…', 'Select people…')
      : selectedUsers.length === 1 && customCount === 0
        ? selectedUsers[0].display_name || selectedUsers[0].email
        : tr(`已选 ${selected.length} 位收件人`, `${selected.length} recipients`);

  const toggle = (email: string) => {
    const next = new Set(chosen);
    if (next.has(email)) next.delete(email);
    else next.add(email);
    onChange([...next]);
  };

  return (
    <Popover>
      <PopoverTrigger
        aria-label={tr('选择收件人', 'Select recipients')}
        disabled={disabled}
        className={cn(
          'flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs text-text transition-colors',
          'hover:bg-card/80 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <UserRound size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
        <span className={cn('min-w-0 flex-1 truncate text-left', selected.length === 0 && 'text-text-faint')}>
          {label}
        </span>
        {selected.length > 0 && (
          <span className="shrink-0 rounded-full bg-indigo-500/15 px-1.5 py-0.5 text-[10px] leading-none text-indigo-600 dark:text-indigo-300">
            {selected.length}
          </span>
        )}
        <ChevronDown size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" aria-label={tr('选择收件人', 'Select recipients')}>
        <PopoverTitle className="sr-only">{tr('选择收件人', 'Select recipients')}</PopoverTitle>
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label={tr('搜索员工', 'Search people')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr('搜索姓名或邮箱…', 'Search name or email…')}
              className="pl-7"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {loading ? (
            <p className="px-2 py-3 text-xs text-text-muted">{tr('正在加载员工…', 'Loading people…')}</p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-3 text-xs text-text-muted">
              {users.length === 0 ? tr('没有可选的员工。', 'No people available.') : tr('没有匹配的员工', 'No matching people')}
            </p>
          ) : (
            filtered.map((user) => (
              <label
                key={user.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-card"
              >
                <Checkbox
                  checked={chosen.has(user.email)}
                  onCheckedChange={() => toggle(user.email)}
                  aria-label={user.display_name || user.email}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-text">{user.display_name || user.email}</span>
                  <span className="block truncate font-mono text-[10px] text-text-faint">{user.email}</span>
                </span>
              </label>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
