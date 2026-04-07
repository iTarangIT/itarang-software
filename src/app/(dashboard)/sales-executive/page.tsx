import { requireRole } from '@/lib/auth-utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, Target, CheckCircle, Clock } from 'lucide-react';

export default async function SalesExecutiveDashboard() {
    const user = await requireRole(['sales_executive', 'ceo']);

    return (
        <div className="p-8 space-y-8">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">Sales Executive Dashboard</h1>
                <p className="text-muted-foreground">Welcome back, {user.name}. Here is your on-ground lead management overview.</p>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Card className="bg-blue-50/50 border-blue-100">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium text-blue-900">Assigned Leads</CardTitle>
                        <Users className="h-4 w-4 text-blue-600" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-blue-900">24</div>
                        <p className="text-xs text-blue-600">+2 since yesterday</p>
                    </CardContent>
                </Card>

                <Card className="bg-amber-50/50 border-amber-100">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium text-amber-900">Hot Leads</CardTitle>
                        <Target className="h-4 w-4 text-amber-600" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-amber-900">8</div>
                        <p className="text-xs text-amber-600">Requires follow-up</p>
                    </CardContent>
                </Card>

                <Card className="bg-emerald-50/50 border-emerald-100">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium text-emerald-900">Conversions</CardTitle>
                        <CheckCircle className="h-4 w-4 text-emerald-600" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-emerald-900">5</div>
                        <p className="text-xs text-emerald-600">MTD</p>
                    </CardContent>
                </Card>

                <Card className="bg-rose-50/50 border-rose-100">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium text-rose-900">Open Tasks</CardTitle>
                        <Clock className="h-4 w-4 text-rose-600" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-rose-900">12</div>
                        <p className="text-xs text-rose-600">3 overdue</p>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
                <Card className="lg:col-span-4">
                    <CardHeader>
                        <CardTitle>Recent Assigned Leads</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-sm text-muted-foreground">
                            Lead list will be populated here.
                        </div>
                    </CardContent>
                </Card>
                <Card className="lg:col-span-3">
                    <CardHeader>
                        <CardTitle>Upcoming Visits</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-sm text-muted-foreground">
                            Today's schedule will be populated here.
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
