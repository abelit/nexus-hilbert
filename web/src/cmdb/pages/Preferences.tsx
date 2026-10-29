import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { PageHeader } from '@/components/ui/PageHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useI18n } from '@/i18n/locale';

import { ModelGroupsPanel } from '../components/preferences/ModelGroupsPanel';
import { SavedSearchesPanel } from '../components/preferences/SavedSearchesPanel';
import SubscriptionsPage from './Subscriptions';

// 我的订阅 — the one page for "how I see the CMDB".
//
// THE TABS ARE INDEPENDENT PANELS, not one form: a subscription is per user,
// a model group is shared configuration, and a saved search belongs to the
// person who made it. One save button across them would silently apply the
// wrong ownership rule to half the page.
//
// THE HIERARCHY LIVES INSIDE THE FIRST TAB now, not in a tab of its own: cantor
// treated "which columns the list shows" and "which columns the tree expands"
// as two halves of the same per-model subscription, and a separate tab made the
// operator pick the same model twice.

type Tab = 'subscriptions' | 'groups' | 'searches';

const TABS: Tab[] = ['subscriptions', 'groups', 'searches'];

function tabFrom(value: string | null): Tab | null {
  // `models` and `tree` are the old tab names; both used to be subscription
  // views, so a bookmark that names either still lands on the right panel.
  if (value === 'models' || value === 'tree') return 'subscriptions';
  return value && (TABS as string[]).includes(value) ? (value as Tab) : null;
}

export default function PreferencesPage() {
  const { tr } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => tabFrom(searchParams.get('tab')) ?? 'subscriptions');
  // The subscription panel owns the refresh and auto-subscription controls,
  // but they belong in the page header like every other page's actions. The
  // panel portals them into this slot instead of duplicating their state here.
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);

  // The URL is also the state when the operator uses back/forward or follows a
  // deep link while the page is already mounted.
  useEffect(() => {
    const requested = tabFrom(searchParams.get('tab'));
    if (requested) setTab(requested);
  }, [searchParams]);

  const changeTab = (next: string) => {
    const value = tabFrom(next);
    if (!value) return;
    setTab(value);
    const params = new URLSearchParams(searchParams);
    params.set('tab', value);
    setSearchParams(params, { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <PageHeader
        title={tr('我的订阅', 'My subscriptions')}
        subtitle={tr(
          '选择每个模型显示的列与层级，并管理共享分组和你的保存搜索。',
          'Choose the columns and hierarchy each model shows, and manage shared groups and your saved searches.',
        )}
        actions={
          tab === 'subscriptions' ? (
            <div ref={setActionsSlot} className="flex flex-wrap items-center gap-2" />
          ) : undefined
        }
      />

      {/* The root is a flex column so a tab panel can fill the remaining height
          and let its own body scroll. Without it the panel grows to its content,
          and on a narrow window the catalogue below the fold is clipped by the
          app shell instead of scrolling. */}
      <Tabs value={tab} onValueChange={changeTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-6 mt-4">
          <TabsTrigger value="subscriptions">{tr('订阅', 'Subscriptions')}</TabsTrigger>
          <TabsTrigger value="groups">{tr('模型分组', 'Model groups')}</TabsTrigger>
          <TabsTrigger value="searches">{tr('保存搜索', 'Saved searches')}</TabsTrigger>
        </TabsList>

        <TabsContent value="subscriptions" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <SubscriptionsPage
            embedded
            headerActionsTarget={tab === 'subscriptions' ? actionsSlot : null}
          />
        </TabsContent>
        <TabsContent value="groups" className="min-h-0 flex-1 overflow-y-auto p-6">
          <ModelGroupsPanel />
        </TabsContent>
        <TabsContent value="searches" className="min-h-0 flex-1 overflow-y-auto p-6">
          <SavedSearchesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
