"use client";

import { NotificationAccessManager } from "./NotificationAccessManager";

// Notification Access (E-231) is the only section on this page.
//
// KYC Automation (E-246) briefly lived here as a second tab, and was moved out
// to its own route (/admin/settings/kyc-automation) and its own sidebar entry —
// so the tab strip went away again with it. A one-item tab bar is dead chrome.
//
// The Assignment Config, Holiday Calendar and ASM Territories tabs were removed
// on request before that. Their components (AssignmentConfigForm,
// HolidayCalendarManager, TerritoryManager) and the /api/admin/settings bundle
// they read are left in place and untouched — only the tab strip that mounted
// them is gone, so restoring a tab is re-adding it here rather than rebuilding
// the feature. Bring back `Tabs` (and the bundled useQuery, which only those
// three tabs consumed) if a second section is ever added back to THIS page.

export function SettingsView() {
    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="p-5">
                <NotificationAccessManager />
            </div>
        </div>
    );
}
