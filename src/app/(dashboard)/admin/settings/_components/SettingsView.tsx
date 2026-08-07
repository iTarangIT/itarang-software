"use client";

import { NotificationAccessManager } from "./NotificationAccessManager";

// Notification Access (E-231) is the only section on this page.
//
// The Assignment Config, Holiday Calendar and ASM Territories tabs were removed
// on request. Their components (AssignmentConfigForm, HolidayCalendarManager,
// TerritoryManager) and the /api/admin/settings bundle they read are left in
// place and untouched — only the tab strip that mounted them is gone, so
// restoring a tab is re-adding it here rather than rebuilding the feature.
//
// The tab strip went with them: a one-item tab bar is dead chrome. Bring back
// `Tabs` (and the bundled useQuery, which only those three tabs consumed) if a
// second section is ever added.

export function SettingsView() {
    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="p-5">
                <NotificationAccessManager />
            </div>
        </div>
    );
}
