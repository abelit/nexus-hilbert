import { getTicketStats, listMyTickets, listTickets } from '@/api/federation';
import {
  FederatedListPanel,
  type FederatedApi,
  type FederatedField,
} from '@/pages/federation/FederatedListPanel';

const TICKET_BUILTIN = {
  status: { path: 'form_data.instanceStatus', zh: '状态', en: 'Status' },
  title: { path: 'form_data.title', zh: '标题', en: 'Title' },
  priority: { path: 'form_data.priority', zh: '优先级', en: 'Priority' },
  assignee: { path: 'form_data.assignee', zh: '处理人', en: 'Assignee' },
  created: { path: 'created_at', zh: '创建时间', en: 'Created' },
};

const TICKET_FIELDS: FederatedField[] = [
  { key: 'status', ...TICKET_BUILTIN.status, render: 'badge' },
  { key: 'title', ...TICKET_BUILTIN.title, render: 'text' },
  { key: 'priority', ...TICKET_BUILTIN.priority, render: 'badge' },
  { key: 'assignee', ...TICKET_BUILTIN.assignee, render: 'text' },
  { key: 'created', ...TICKET_BUILTIN.created, render: 'time' },
];

const TICKET_STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'ERROR', label: 'Error' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'TERMINATED', label: 'Terminated' },
];

const TICKET_API: FederatedApi = {
  list: listTickets,
  mine: listMyTickets,
  stats: getTicketStats,
};

export function TicketsPanel() {
  return (
    <FederatedListPanel
      kind="itsm_ticket"
      titleZh="事件中心"
      titleEn="Event center"
      subtitleZh="只读 · 数据来自钉钉 ITSM"
      subtitleEn="Read-only · sourced from DingTalk ITSM"
      nounZh="事件"
      nounEn="events"
      defaultFields={TICKET_FIELDS}
      builtinPaths={TICKET_BUILTIN}
      statusOptions={TICKET_STATUS_OPTIONS}
      settingsPath="/settings/federation"
      defaultDays={30}
      api={TICKET_API}
    />
  );
}
