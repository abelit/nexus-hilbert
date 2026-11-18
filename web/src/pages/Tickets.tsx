import { TicketsPanel } from './tickets/TicketsPanel';

// 工单管理 → 事件中心. The ITSM source is read-only; the panel renders its own
// page header and keeps the "ticket" vocabulary in code while the UI says
// "事件" to match the product wording.
export default function TicketsPage() {
  return <TicketsPanel />;
}
