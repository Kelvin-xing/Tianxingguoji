import { NotificationsWorkspace } from '@/components/notifications/NotificationsWorkspace'
export default function NotificationsPage() { return <div className="max-w-4xl mx-auto space-y-6"><section><div className="eyebrow">Internal · Notifications</div><h2 className="page-title">通知</h2><p className="page-subtitle">仅显示当前 Session recipient 的最小站内提醒。</p></section><NotificationsWorkspace /></div> }
